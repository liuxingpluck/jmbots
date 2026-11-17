"""微信后台核对的纯函数回归：不截图、不联网、不操作真实窗口。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from wxcontrol.ocr import normalized, find_text
from wxcontrol.controller import context_matches


class VerificationTest(unittest.TestCase):
    def test_full_name_and_duplicate_gate(self):
        region = {'x1': 0, 'y1': 0, 'x2': 400, 'y2': 400}
        lines = [{'text': '【内部】测试群', 'score': .99, 'box': [10, 20, 180, 40]},
                 {'text': '【内部】测试群二', 'score': .99, 'box': [10, 60, 200, 80]}]
        self.assertEqual(len(find_text(lines, '内部测试群', region)), 1)
        lines.append(dict(lines[0], box=[10, 100, 180, 120]))
        self.assertEqual(len(find_text(lines, '内部测试群', region)), 2)

    def test_title_count_normalization(self):
        self.assertEqual(normalized('【内部】测试群 (12)'), normalized('内部测试群'))
        self.assertNotEqual(normalized('内部测试群'), normalized('内部测试群二'))

    def test_context_requires_multiple_messages(self):
        region = {'x1': 400, 'y1': 80, 'x2': 1000, 'y2': 550}
        lines = [{'text': '今天安排设备测试', 'score': .99, 'box': [450, 100, 700, 120]},
                 {'text': '已经收到测试安排', 'score': .98, 'box': [700, 200, 950, 220]}]
        rows = [{'line': '[2026-11-11 12:00] 测试甲: 今天安排设备测试', 'from_self': False},
                {'line': '[2026-11-11 12:01] 测试乙: 已经收到测试安排', 'from_self': True}]
        result = context_matches(lines, rows, region)
        self.assertTrue(result['passed'])
        self.assertEqual((result['selfMessages'], result['otherMessages']), (1, 1))
        self.assertFalse(context_matches(lines, rows[:1], region)['passed'])
        self.assertFalse(context_matches(lines, [{'line': '完全不同的窗口消息'}], region)['passed'])
        lines[0]['fromSelf'] = True
        lines[1]['fromSelf'] = False
        self.assertFalse(context_matches(lines, rows, region)['passed'])

    def test_region_excludes_search_and_composer(self):
        region = {'x1': 400, 'y1': 80, 'x2': 1000, 'y2': 550}
        lines = [{'text': '相同测试文本内容', 'score': .99, 'box': [50, 10, 250, 30]},
                 {'text': '相同测试文本内容', 'score': .99, 'box': [450, 650, 700, 675]}]
        rows = [{'line': '相同测试文本内容'}]
        self.assertEqual(context_matches(lines, rows, region)['matchedMessages'], 0)


if __name__ == '__main__':
    unittest.main()
