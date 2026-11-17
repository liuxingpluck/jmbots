"""PP-OCRv6 本地识别与文字匹配；原始识别文字只在调用进程内流转。"""
import contextlib
import os
import re
import sys
import time
from pathlib import Path


def normalized(text):
    """统一群名/正文的空白与标点，去掉微信标题末尾的群人数。"""
    text = re.sub(r'[（(]\d+[）)]\s*$', '', str(text))
    return ''.join(c.casefold() for c in text if c.isalnum())


def in_region(line, region):
    """按 OCR 框中心判断所属区域，坐标均为客户区像素。"""
    x1, y1, x2, y2 = line['box']
    return region['x1'] <= (x1 + x2) / 2 <= region['x2'] and region['y1'] <= (y1 + y2) / 2 <= region['y2']


def find_text(lines, text, region, minimum=0.75):
    """只接受区域内的完整文字匹配；不把相近群名作为目标。"""
    expected = normalized(text)
    return [line for line in lines if line['score'] >= minimum and in_region(line, region) and normalized(line['text']) == expected]


class Ocr:
    """懒加载且复用 GPU 管线；模型目录固定为项目内现有 PP-OCRv6。"""
    def __init__(self, root):
        self.root = Path(root)
        self.pipeline = None

    def recognize(self, image):
        """识别一帧，返回文字、分数、矩形；不打印或落盘识别正文。"""
        if self.pipeline is None:
            runtime = self.root / 'third_party/runtimes/ocr'
            os.environ['PADDLE_PDX_CACHE_HOME'] = str(runtime / 'models')
            os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = '1'
            os.environ['PADDLE_PDX_MODEL_SOURCE'] = 'bos'
            with contextlib.redirect_stdout(sys.stderr):
                from paddleocr import PaddleOCR
                self.pipeline = PaddleOCR(
                    text_detection_model_name='PP-OCRv6_medium_det',
                    text_recognition_model_name='PP-OCRv6_medium_rec',
                    text_detection_model_dir=str(runtime / 'models/official_models/PP-OCRv6_medium_det'),
                    text_recognition_model_dir=str(runtime / 'models/official_models/PP-OCRv6_medium_rec'),
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                    device='gpu:0',
                )
        start = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            pages = list(self.pipeline.predict(image))
        page = pages[0] if pages else {}
        lines = [
            {'text': str(text), 'score': float(score), 'box': [int(v) for v in box]}
            for text, score, box in zip(page.get('rec_texts', []), page.get('rec_scores', []), page.get('rec_boxes', []))
        ]
        return lines, round((time.perf_counter() - start) * 1000)

    def cloud_image(self, image, lines, name, layout):
        """保留目标群名字形，涂掉其他会话和整个消息/输入区后编码；不上传原图。"""
        import cv2
        masked = image.copy()
        height, width = image.shape[:2]
        left = layout['list']
        title = layout['title']
        masked[max(0, title['y1']):height, left['x2']:width] = (45, 45, 45)
        masked[left['y1']:height, 0:left['x2']] = (45, 45, 45)
        masked[0:left['y1'], 0:left['x1']] = (45, 45, 45)
        for line in find_text(lines, name, left):
            x1, y1, x2, y2 = line['box']
            x1, y1 = max(left['x1'], x1 - 3), max(left['y1'], y1 - 3)
            x2, y2 = min(left['x2'], x2 + 3), min(height, y2 + 3)
            masked[y1:y2, x1:x2] = image[y1:y2, x1:x2]
        ok, encoded = cv2.imencode('.png', masked)
        if not ok:
            raise RuntimeError('cloud_image_encode_failed')
        return encoded.tobytes()
