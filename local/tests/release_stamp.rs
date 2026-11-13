//! 基地挑新版本用的 release_stamp 的测试（发 0.3.0 任务第 1 步）：
//! 时间戳在文件名末尾，按它排就是按时间排；“0.2.10”不能按版本字符串排在“0.2.9”前面。
use jmbots_local::supervisor::release_stamp;
use std::path::Path;

#[test]
fn release_stamp_uses_trailing_timestamp() {
    assert_eq!(release_stamp(Path::new("jmbots-server-0.2.10-20261106090228856457.exe")), "20261106090228856457");
    assert_eq!(release_stamp(Path::new("jmbots-server-0.2.9-20261106085354307274.exe")), "20261106085354307274");
    // 新时间戳排在旧时间戳后面，和版本号字面无关。
    assert!(release_stamp(Path::new("jmbots-server-0.2.10-20261106090228856457.exe")) > release_stamp(Path::new("jmbots-server-0.2.9-20261106085354307274.exe")));
    // 没有时间戳的旧文件名是空字符串，排在最前。
    assert_eq!(release_stamp(Path::new("jmbots-server-0.3.0.exe")), "");
}
