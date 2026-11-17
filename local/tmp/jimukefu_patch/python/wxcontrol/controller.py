"""微信后台动作：AOBW 负责窗口消息，PaddleOCR 负责核对；只在所有门槛通过后回车一次。

输入仅由本机 Cordis 入口通过 JSON 提供；输出和审计只含步骤、坐标、数量及匹配结果。
截图和聊天正文不输出到日志，真实发送没有自动重试。剪贴板通过 OLE 保存并恢复完整对象。
"""
import contextlib
import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from .decision import DecisionModel
from .ocr import Ocr, find_text, in_region, normalized


class Aobw:
    """仅访问显式本机 AOBW；鼠标调用始终带 background。"""
    def __init__(self, url, object_name='wxcontrol'):
        if not re.fullmatch(r'http://127\.0\.0\.1:300(?:1\d|2\d|30)', url):
            raise RuntimeError('aobw_url_not_local')
        self.url = url
        self.object_name = object_name

    def request(self, path, body=None, binary=False):
        """调用本机接口；异常只带状态码，不回显响应或鉴权。"""
        data = None if body is None else json.dumps(body).encode('utf-8')
        headers = {} if data is None else {'Content-Type': 'application/json'}
        token = os.environ.get('AOBW_TOKEN', '')
        if token:
            headers['Authorization'] = 'Bearer ' + token
        try:
            request = urllib.request.Request(self.url + path, data=data, headers=headers)
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.read() if binary else json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError('aobw_http_' + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError('aobw_unreachable') from None

    def call(self, name, args, required=False):
        """按 AOBW 目录调用大漠方法，副作用接口还检查返回值为 1。"""
        body = {'name': name, 'args': args, 'object': self.object_name}
        if name in {'MoveTo', 'LeftClick', 'RightClick', 'WheelDown', 'WheelUp'}:
            body['mouse_mode'] = 'background'
        value = self.request('/api/call?engine=dm', body)
        if value.get('ok') is not True or (required and value.get('result') != 1):
            raise RuntimeError('aobw_call_failed_' + name)
        return value


class Clipboard:
    """保存原剪贴板 IDataObject；写入 Unicode 后在退出时恢复全部原格式。"""
    def __enter__(self):
        self.ole = ctypes.OleDLL('ole32')
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.saved = ctypes.c_void_p()
        self.initialized = False
        result = self.ole.OleInitialize(None)
        if result not in (0, 1):
            raise RuntimeError('clipboard_ole_initialize_failed')
        self.initialized = True
        try:
            self.ole.OleGetClipboard(ctypes.byref(self.saved))
        except OSError:
            self.ole.OleUninitialize()
            raise RuntimeError('clipboard_snapshot_failed') from None
        self.kernel.GlobalAlloc.restype = ctypes.c_void_p
        self.kernel.GlobalAlloc.argtypes = [wt.UINT, ctypes.c_size_t]
        self.kernel.GlobalLock.restype = ctypes.c_void_p
        self.kernel.GlobalLock.argtypes = [ctypes.c_void_p]
        self.kernel.GlobalUnlock.argtypes = [ctypes.c_void_p]
        self.user.SetClipboardData.restype = ctypes.c_void_p
        self.user.SetClipboardData.argtypes = [wt.UINT, ctypes.c_void_p]
        return self

    def write(self, text):
        """写入本次授权文字；不打印、复制或保存原剪贴板内容。"""
        encoded = (text + '\0').encode('utf-16-le')
        for attempt in range(5):
            if self.user.OpenClipboard(None):
                break
            time.sleep(0.03)
        else:
            raise RuntimeError('clipboard_busy')
        try:
            memory = self.kernel.GlobalAlloc(0x0002, len(encoded))
            address = self.kernel.GlobalLock(memory)
            if not memory or not address:
                raise RuntimeError('clipboard_allocate_failed')
            ctypes.memmove(address, encoded, len(encoded))
            self.kernel.GlobalUnlock(memory)
            if not self.user.EmptyClipboard() or not self.user.SetClipboardData(13, memory):
                raise RuntimeError('clipboard_write_failed')
        finally:
            self.user.CloseClipboard()

    def __exit__(self, exc_type, exc, traceback):
        try:
            self.ole.OleSetClipboard(self.saved)
            if self.saved:
                self.ole.OleFlushClipboard()
                vtable = ctypes.cast(self.saved, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
                release = ctypes.WINFUNCTYPE(wt.ULONG, ctypes.c_void_p)(vtable[2])
                release(self.saved)
        finally:
            if self.initialized:
                self.ole.OleUninitialize()


class GuiThreadInfo(ctypes.Structure):
    """GetGUIThreadInfo 的 Win32 结构，取得目标 Qt 线程当前输入焦点。"""
    _fields_ = [('cbSize', wt.DWORD), ('flags', wt.DWORD), ('hwndActive', wt.HWND),
                ('hwndFocus', wt.HWND), ('hwndCapture', wt.HWND), ('hwndMenuOwner', wt.HWND),
                ('hwndMoveSize', wt.HWND), ('hwndCaret', wt.HWND), ('rcCaret', wt.RECT)]


def thread_key(hwnd, key, control=False, message=None):
    """只向目标窗口发键盘消息，临时保存/恢复目标输入队列状态；不激活窗口、不调用 SendInput。"""
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    user.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    user.GetWindowThreadProcessId.restype = wt.DWORD
    user.GetGUIThreadInfo.argtypes = [wt.DWORD, ctypes.POINTER(GuiThreadInfo)]
    user.SendMessageTimeoutW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM, wt.UINT, wt.UINT, ctypes.POINTER(ctypes.c_size_t)]
    user.SendMessageTimeoutW.restype = wt.LPARAM
    target_thread = user.GetWindowThreadProcessId(int(hwnd, 16), None)
    current_thread = kernel.GetCurrentThreadId()
    attached = current_thread != target_thread
    if attached and not user.AttachThreadInput(current_thread, target_thread, True):
        raise RuntimeError('background_attach_thread_failed')
    saved = (ctypes.c_ubyte * 256)()
    user.GetKeyboardState(saved)
    try:
        info = GuiThreadInfo()
        info.cbSize = ctypes.sizeof(info)
        user.GetGUIThreadInfo(target_thread, ctypes.byref(info))
        destination = info.hwndFocus or int(hwnd, 16)
        state = (ctypes.c_ubyte * 256).from_buffer_copy(saved)
        state[0x11] = 0x80 if control else 0
        state[0xA2] = 0x80 if control else 0
        user.SetKeyboardState(state)
        result = ctypes.c_size_t()
        if message is not None:
            if not user.SendMessageTimeoutW(destination, message, 0, 0, 2, 2000, ctypes.byref(result)):
                raise RuntimeError('background_window_message_timeout')
        else:
            scan = user.MapVirtualKeyW(key, 0)
            for msg, flags in ((0x100, 1 | (scan << 16)), (0x101, 1 | (scan << 16) | 0xC0000000)):
                if not user.SendMessageTimeoutW(destination, msg, key, flags, 2, 2000, ctypes.byref(result)):
                    raise RuntimeError('background_key_message_timeout')
    finally:
        user.SetKeyboardState(saved)
        if attached:
            user.AttachThreadInput(current_thread, target_thread, False)


def message_body(row):
    """仅在内存中拆出数据库格式化行的发送者和正文。"""
    match = re.match(r'^\[[^\]]+\]\s*(.*?)[:：]\s*([\s\S]*)$', row.get('line', ''))
    return (match[1], match[2]) if match else ('', row.get('line', ''))


def context_matches(lines, messages, region):
    """按可见 OCR 行匹配数据库近期消息，输出计数；不返回原文或发送者姓名。"""
    visible = sorted((line for line in lines if line['score'] >= 0.7 and in_region(line, region)), key=lambda line: (line['box'][1], line['box'][0]))
    strings = [normalized(line['text']) for line in visible]
    joined = [(''.join(strings[i:i + size]), visible[i].get('fromSelf')) for i in range(len(strings)) for size in (1, 2, 3)]
    matched, self_count, other_count, sender_count, direction_errors = 0, 0, 0, 0, 0
    used = set()
    for row in messages:
        sender, body = message_body(row)
        text = normalized(body)
        if len(text) < 5 or text in used:
            continue
        snippet = text[:min(len(text), 28)]
        matching = [(value, side) for value, side in joined if snippet in value or (len(value) >= 8 and value in text)]
        if not matching:
            continue
        known_sides = [side for _value, side in matching if side is not None]
        if row.get('from_self') is not None and known_sides and row['from_self'] not in known_sides:
            direction_errors += 1
        used.add(text)
        matched += 1
        self_count += row.get('from_self') is True
        other_count += row.get('from_self') is False
        sender_count += bool(sender and any(normalized(sender) == value for value in strings))
    return {'matchedMessages': matched, 'selfMessages': self_count, 'otherMessages': other_count,
            'senderLabelsMatched': sender_count, 'visibleOcrLines': len(visible),
            'directionMismatches': direction_errors, 'passed': matched >= 2 and direction_errors == 0}


class Controller:
    """一个进程复用一套 OCR；动作始终在同一后台绑定内执行并最终解绑。"""
    def __init__(self, root):
        self.root = Path(root)
        self.ocr = Ocr(root)
        self.decision = DecisionModel(root)
        self.request = None
        self.image = None
        self.lines = []
        self.steps = []

    def capture(self):
        """下载当前绑定窗口的客户区截图，只保存在内存。"""
        import cv2
        import numpy as np
        size = self.api.call('GetClientSize', [self.hwnd])['out']
        width, height = int(size['width']), int(size['height'])
        if abs(width - self.frame['width']) > 2 or abs(height - self.frame['height']) > 2:
            raise RuntimeError('window_size_changed')
        result = self.api.call('Capture', [0, 0, width - 1, height - 1, 'wxcontrol_' + uuid.uuid4().hex + '.bmp'], True)
        data = self.api.request(result['capture']['preview_url'], binary=True)
        self.image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
        if self.image is None or float(self.image.mean()) < 2:
            raise RuntimeError('background_capture_black')
        self.lines, ms = self.ocr.recognize(self.image)
        return ms

    def locate(self, backend='paddle'):
        """从当前可见列表精确找目标；云模型坐标必须再被本地 OCR 文字核对。"""
        ms = self.capture()
        hits = find_text(self.lines, self.name, self.layout['list'])
        result = {'backend': backend, 'matches': len(hits), 'ocrMs': ms, 'found': False}
        if backend == 'cloud':
            if not self.request.get('cloudAllowed', False):
                raise RuntimeError('cloud_real_image_approval_required')
            png = self.ocr.cloud_image(self.image, self.lines, self.name, self.layout)
            answer = self.decision.box(png, 'the conversation name text "' + self.name + '" in the left conversation list')
            box = answer['box']
            height, width = self.image.shape[:2]
            point = [int((box['left'] + box['right']) * width / 2), int((box['top'] + box['bottom']) * height / 2)]
            agrees = len(hits) == 1 and hits[0]['box'][0] - 10 <= point[0] <= hits[0]['box'][2] + 10 and hits[0]['box'][1] - 10 <= point[1] <= hits[0]['box'][3] + 10
            result.update({'model': answer['model'], 'confidence': answer['confidence'], 'cloudMs': answer['ms'], 'ocrAgrees': agrees})
            if answer['confidence'] >= 0.3 and agrees:
                result.update(found=True, x=point[0], y=point[1])
        elif len(hits) == 1:
            box = hits[0]['box']
            result.update(found=True, x=(box[0] + box[2]) // 2, y=(box[1] + box[3]) // 2, confidence=hits[0]['score'])
        return result

    def click(self, x, y):
        """后台移动虚拟鼠标并单击，不移动用户的真实指针。"""
        self.api.call('MoveTo', [int(x), int(y)], True)
        self.api.call('LeftClick', [], True)
        time.sleep(0.15)

    def paste(self, text, method, clipboard):
        """尝试指定后台粘贴方法；此函数从不按回车。"""
        clipboard.write(text)
        if method == 'dm-ctrl-v':
            self.api.call('KeyDownChar', ['ctrl'], True)
            try:
                self.api.call('KeyPressChar', ['v'], True)
            finally:
                self.api.call('KeyUpChar', ['ctrl'], True)
        elif method == 'wm-paste':
            thread_key(self.hwnd, 0, message=0x302)
        elif method == 'thread-ctrl-v':
            thread_key(self.hwnd, ord('V'), control=True)
        else:
            raise RuntimeError('unknown_paste_method')
        time.sleep(0.25)

    def clear(self, x, y):
        """仅用于本脚本写过的输入框：移到末尾后删掉测试字，不使用全局键盘。"""
        self.click(x, y)
        self.api.call('KeyPress', [35], True)
        for _ in range(max(32, len(self.name) + 8)):
            self.api.call('KeyPress', [8], True)
        time.sleep(0.15)

    def open(self):
        """可见列表优先；不可见时后台点搜索框，核对唯一结果后点击，最后核对标题。"""
        located = self.locate(self.request.get('backend', 'paddle'))
        searched = False
        if not located['found'] or self.request.get('forceSearch', False):
            if not self.request.get('allowSearch', True):
                raise RuntimeError('target_not_visible')
            region = self.layout['list']
            x, y = int((region['x1'] + region['x2']) / 2), int(region['y1'] / 2)
            self.click(x, y)
            # 搜索框是本次明确选择的输入目标；不按 Enter，直接匹配结果列表。
            self.api.call('SendString', [self.hwnd, self.name], True)
            searched = True
            for _ in range(8):
                time.sleep(0.3)
                located = self.locate('paddle')
                if located['found']:
                    break
            if not located['found']:
                raise RuntimeError('search_result_not_unique_or_missing')
        self.click(located['x'], located['y'])
        for _ in range(6):
            self.capture()
            if find_text(self.lines, self.name, self.layout['title']):
                self.steps.append('title-verified')
                return {'located': located, 'searched': searched, 'titleMatched': True}
            time.sleep(0.2)
        raise RuntimeError('opened_title_mismatch')

    def messages(self, since=None):
        """通过项目只读 CLI 获取目标会话近期消息，正文只在进程内用于比对。"""
        env = {**os.environ, 'PYTHONPATH': str(self.root / 'python'), 'JIMUKEFU_ACCOUNT': self.target['account'],
               'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'TEMP': str(self.root / 'var/tmp'), 'TMP': str(self.root / 'var/tmp')}
        command = [str(self.root / 'third_party/runtimes/python/python.exe'), '-B', '-s', '-m', 'wechat_cli.portable_entry', 'sync', self.target['chat'], '--limit', '200']
        if since is not None:
            command.extend(['--since-time', str(since)])
        run = subprocess.run(command, cwd=self.root, env=env, capture_output=True, timeout=120,
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if run.returncode:
            raise RuntimeError('target_database_query_failed')
        value = json.loads(run.stdout.decode('utf-8-sig'))
        return value.get('messages', [])

    def verify(self):
        """标题精确匹配，并将消息区 OCR 与目标群近期数据库消息做本地比对。"""
        self.capture()
        if not find_text(self.lines, self.name, self.layout['title']):
            raise RuntimeError('current_title_mismatch')
        messages = self.messages()
        # 微信当前深色主题的自身气泡为绿色；只在消息区采样，不把列表选中绿底当作气泡。
        for line in self.lines:
            if not in_region(line, self.body_region()):
                continue
            x1, y1, x2, y2 = line['box']
            pixels = self.image[max(0,y1-3):y2+3,max(0,x1-3):x2+3].astype('float32')
            if pixels.size:
                blue, green, red = pixels[:,:,0], pixels[:,:,1], pixels[:,:,2]
                line['fromSelf'] = bool(((green > 50) & (green > red * 1.3) & (green > blue * 1.2)).mean() > 0.15)
        result = context_matches(self.lines, messages, self.body_region())
        if not result['passed']:
            raise RuntimeError('context_insufficient_matches_' + str(result['matchedMessages']))
        self.steps.append('context-verified')
        return result

    def body_region(self):
        """消息区不含标题、搜索、工具栏、输入框。"""
        return {'x1': self.layout['list']['x2'] + 10, 'y1': self.layout['title']['y2'] + 5,
                'x2': self.frame['width'] - 15, 'y2': int(self.frame['height'] * 0.66)}

    def composer_region(self):
        """输入文字区域，排除工具栏和底部发送按钮。"""
        return {'x1': self.layout['list']['x2'] + 12, 'y1': int(self.frame['height'] * 0.7),
                'x2': self.frame['width'] - 20, 'y2': int(self.frame['height'] * 0.94)}

    def composer_text(self):
        """读取输入区域的 OCR 结果，仅用于本机精确相等判断。"""
        region = self.composer_region()
        return ''.join(line['text'] for line in sorted(self.lines, key=lambda line: (line['box'][1], line['box'][0]))
                       if line['score'] >= 0.65 and in_region(line, region))

    def paste_probe(self, text):
        """逐一验证三种粘贴方式并清空测试内容，任何方式都不按 Enter。"""
        self.capture()
        if normalized(self.composer_text()):
            raise RuntimeError('composer_has_existing_draft')
        region = self.composer_region()
        x, y = int((region['x1'] + region['x2']) / 2), int((region['y1'] + region['y2']) / 2)
        methods = []
        with Clipboard() as clipboard:
            for method in ('dm-ctrl-v', 'wm-paste', 'thread-ctrl-v'):
                self.click(x, y)
                error = None
                try:
                    self.paste(text, method, clipboard)
                    self.capture()
                    passed = normalized(self.composer_text()) == normalized(text)
                except RuntimeError as failure:
                    passed, error = False, str(failure)
                methods.append({'method': method, 'passed': passed, 'error': error})
                self.clear(x, y)
                self.capture()
                if normalized(self.composer_text()):
                    raise RuntimeError('probe_input_cleanup_failed')
        self.steps.append('paste-probed-without-enter')
        return {'methods': methods, 'usable': [item['method'] for item in methods if item['passed']]}

    def send(self, text, method):
        """核对目标、内容、输入文字及标题，创建一次性门禁后只回车一次；结果不明确时只查库。"""
        if text != 'AI测试发送':
            raise RuntimeError('this_request_only_authorizes_fixed_test_text')
        verification = self.verify()
        self.capture()
        if normalized(self.composer_text()):
            raise RuntimeError('composer_has_existing_draft')
        region = self.composer_region()
        x, y = int((region['x1'] + region['x2']) / 2), int((region['y1'] + region['y2']) / 2)
        identity = hashlib.sha256((self.target['account'] + self.target['chat'] + text).encode('utf-8')).hexdigest()
        marker = self.root / 'var/data/send-once' / (identity + '.json')
        marker.parent.mkdir(parents=True, exist_ok=True)
        if marker.exists():
            raise RuntimeError('send_already_reserved_no_retry')
        with Clipboard() as clipboard:
            self.click(x, y)
            self.paste(text, method, clipboard)
            self.capture()
            if normalized(self.composer_text()) != normalized(text):
                self.clear(x, y)
                raise RuntimeError('composer_text_mismatch_no_enter')
            if not find_text(self.lines, self.name, self.layout['title']):
                self.clear(x, y)
                raise RuntimeError('final_title_mismatch_no_enter')
            since = int(time.time())
            payload = {'status': 'reserved', 'since': since, 'requestHash': identity, 'textLength': len(text)}
            with marker.open('x', encoding='utf-8') as out:
                json.dump(payload, out)
            # 唯一的发送点：在保留门禁后按一次 Enter，后续无论发生什么都不重发。
            self.api.call('KeyPressChar', ['enter'], True)
            self.steps.append('enter-once')
            payload['status'] = 'enter-issued'
            marker.write_text(json.dumps(payload), encoding='utf-8')
            for _ in range(25):
                time.sleep(2)
                messages = self.messages(since)
                if any(row.get('from_self') is True and row.get('create_time', 0) >= since and normalized(message_body(row)[1]) == normalized(text) for row in messages):
                    payload['status'] = 'confirmed'
                    payload['confirmedAt'] = int(time.time())
                    marker.write_text(json.dumps(payload), encoding='utf-8')
                    return {'confirmed': True, 'enterCount': 1, 'context': verification, 'marker': str(marker.relative_to(self.root))}
            return {'confirmed': False, 'enterCount': 1, 'status': 'awaiting-readonly-confirmation', 'marker': str(marker.relative_to(self.root))}

    def run(self, request):
        """执行一个串行请求；每次绑定只归本请求所有，退出总会解绑和放锁。"""
        self.request = request
        self.frame = request['frame']
        self.layout = self.frame['layout']
        self.hwnd = self.frame['hwnd']
        self.target = request['target']
        self.name = self.target['name']
        self.steps = []
        self.api = Aobw(request['aobwUrl'])
        status = self.api.request('/api/engine/status?engine=dm')
        if status.get('registered') is not True:
            raise RuntimeError('dm_not_registered')
        lock = Path(request['lockFile'])
        lock.parent.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        descriptor = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as file:
            json.dump({'owner': 'wxcontrol', 'pid': os.getpid(), 'token': token}, file)
        bound = False
        try:
            if self.api.call('GetWindowState', [self.hwnd, 3]).get('result') == 1:
                raise RuntimeError('window_minimized')
            self.api.call('BindWindow', [self.hwnd, 'gdi2', 'windows', 'windows', 0], True)
            bound = True
            operation = request['operation']
            if operation == 'locate':
                result = self.locate(request.get('backend', 'paddle'))
            elif operation == 'open':
                result = {**self.open(), 'context': self.verify()}
            elif operation == 'verify':
                result = self.verify()
            elif operation == 'paste-probe':
                self.verify()
                result = self.paste_probe(request.get('text', 'AI测试发送'))
            elif operation == 'send':
                result = self.send(request['text'], request['pasteMethod'])
            else:
                raise RuntimeError('unknown_operation')
            result['steps'] = self.steps
            return result
        finally:
            if bound:
                with contextlib.suppress(Exception):
                    self.api.call('UnBindWindow', [], True)
            with contextlib.suppress(Exception):
                if json.loads(lock.read_text(encoding='utf-8')).get('token') == token:
                    lock.unlink()
