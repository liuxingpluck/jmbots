"""System One 云端/本地决策模型接口；只接收调用方已打码的 PNG，不接触聊天库。"""
import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path


class DecisionModel:
    """默认使用已有 Vela 云 API；将来可显式配置本地同协议地址。"""
    def __init__(self, root):
        self.root = Path(root)
        self.endpoint = os.environ.get('JIMUKEFU_DECISION_URL', 'https://app.vllm-sr.ai/v1/systemone')
        self.model = os.environ.get('JIMUKEFU_DECISION_MODEL', 'vllm-sr/vela3-turbo')

    def box(self, masked_png, instructions):
        """问一个定位框；只返回归一化坐标、置信度、用量和耗时，异常不回显服务端正文。"""
        key_file = self.root / 'var/data/secrets/vllm_sr.key'
        key = os.environ.get('JIMUKEFU_DECISION_KEY', '')
        if not key and key_file.is_file():
            key = key_file.read_text(encoding='utf-8').strip()
        if not key:
            raise RuntimeError('decision_key_missing')
        body = json.dumps({
            'model': self.model,
            'state': 'A masked WeChat desktop screenshot. Only the target chat name is visible in the left list.',
            'images': ['data:image/png;base64,' + base64.b64encode(masked_png).decode('ascii')],
            'questions': {'target': {'type': 'box', 'instructions': instructions}},
        }).encode('utf-8')
        request = urllib.request.Request(self.endpoint, data=body, headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
        }, method='POST')
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError('decision_http_' + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError('decision_network_error') from None
        answer = payload.get('answers', {}).get('target', {})
        box = answer.get('box', {})
        if not all(isinstance(box.get(k), (int, float)) and 0 <= box[k] <= 1 for k in ('left', 'top', 'right', 'bottom')):
            raise RuntimeError('decision_invalid_box')
        if box['left'] >= box['right'] or box['top'] >= box['bottom']:
            raise RuntimeError('decision_inverted_box')
        return {'box': box, 'confidence': float(answer.get('confidence', 0)),
                'ms': round((time.perf_counter() - start) * 1000), 'usage': payload.get('usage', {}), 'model': self.model}
