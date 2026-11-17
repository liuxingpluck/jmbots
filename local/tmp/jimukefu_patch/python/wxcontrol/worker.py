"""Cordis 的本地 OCR/窗口 worker：一行 JSON 一个请求，stdout 仅返回无正文的结果。"""
import json
import sys
from pathlib import Path

from .controller import Controller


def main():
    """复用一次 OCR 加载；异常仅返回预定义代码，不打印原始响应或聊天。"""
    root = Path(__file__).resolve().parents[2]
    controller = Controller(root)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = controller.run(request)
            response = {'ok': True, 'result': result}
        except Exception as error:
            detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            response = {'ok': False, 'error': detail}
        print(json.dumps(response, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
