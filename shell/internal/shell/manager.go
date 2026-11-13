// 本文件管理壳子的内存状态、磁盘状态与操作互斥；不依赖 jmbots 源码。
package shell

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"jmbots-shell/internal/logging"
	"jmbots-shell/internal/storage"
	"jmbots-shell/internal/winproc"
)

// Timing 是生产时序；测试只在进程内注入短时间，不写入产品配置。
type Timing struct {
	Startup time.Duration // 启动等待上限。
	Poll    time.Duration // 启动健康轮询间隔。
	Health  time.Duration // 单次 HTTP 超时。
	Check   time.Duration // 守护检查间隔。
	Recheck time.Duration // 失败复查间隔。
	Stable  time.Duration // 已知健康版本确认时间。
	Quiet   time.Duration // 连续失败后的停手时间。
	Stop    time.Duration // 停止与端口释放上限。
}

// DefaultTiming 返回任务书要求的生产时间，不产生副作用。
func DefaultTiming() Timing {
	return Timing{
		Startup: 90 * time.Second,
		Poll:    500 * time.Millisecond,
		Health:  3 * time.Second,
		Check:   30 * time.Second,
		Recheck: 3 * time.Second,
		Stable:  5 * time.Minute,
		Quiet:   10 * time.Minute,
		Stop:    15 * time.Second,
	}
}

// State 是可恢复状态；进程记录不是自动接管权限。
type State struct {
	Current      string            `json:"current"`                 // 当前冻结版本。
	Previous     string            `json:"previous"`                // 上一次正式版本。
	LastGood     string            `json:"last_good"`               // 持续健康五分钟的冻结版本。
	Official     *winproc.Identity `json:"official,omitempty"`      // 正式子进程的身份快照。
	Candidate    *winproc.Identity `json:"candidate,omitempty"`     // 候选子进程的身份快照。
	Mode         string            `json:"mode"`                    // idle/managed/observer/quiet/error。
	Failures     int               `json:"failures"`                // 连续启动失败次数。
	HealthySince time.Time         `json:"healthy_since,omitempty"` // 当前进程的连续健康起点。
	QuietUntil   time.Time         `json:"quiet_until,omitempty"`   // 停手截止时间。
	LastError    string            `json:"last_error,omitempty"`    // 最近可公开的错误。
	UpdatedAt    time.Time         `json:"updated_at"`              // 最后保存时间。
}

// Operation 是可查询且落盘的异步操作。
type Operation struct {
	ID         string    `json:"op_id"`                 // 随机标识，不用于互斥判定。
	Kind       string    `json:"kind"`                  // deploy/rollback/restart/adopt。
	Stage      string    `json:"stage"`                 // 当前阶段。
	Status     string    `json:"status"`                // running/succeeded/failed/interrupted。
	Error      string    `json:"error,omitempty"`       // 脱敏错误。
	StartedAt  time.Time `json:"started_at"`            // 开始时间。
	FinishedAt time.Time `json:"finished_at,omitempty"` // 完成时间。
	LogPath    string    `json:"log_path"`              // 专属换版日志路径。
	Tail       string    `json:"tail,omitempty"`        // 读取时附加的日志尾部。
}

// Request 是控制口允许的换版输入，不接受任意执行命令。
type Request struct {
	ReleaseDir string `json:"release_dir"`          // 已生成发布包的绝对目录。
	SessionID  string `json:"session_id,omitempty"` // 报告目标会话。
}

// Manager 串行编排服务；mu 只保护可快速读取的状态快照。
type Manager struct {
	Config      Config // 启动时校验后的不可变配置。
	timing      Timing
	mu          sync.Mutex
	action      sync.Mutex
	state       State
	ops         map[string]Operation
	active      string
	official    *winproc.Process
	candidate   *winproc.Process
	pendingJobs []*winproc.Process // 停止检查Job失败时保留句柄，下一轮只重试自己的Job。
	instance    io.Closer
	logger      *logging.Writer
	ctx         context.Context // 已接受操作使用的上下文，正常退出等待其有界完成后才取消。
	cancel      context.CancelFunc
	loopCtx     context.Context // 仅停止守护循环，不中断正式切换的关键区。
	loopCancel  context.CancelFunc
	wg          sync.WaitGroup
	lifecycle   sync.Mutex // 串行化后台任务注册与退出，避免 Add/Wait 竞态。
	closing     bool
	closeOnce   sync.Once
	client      *http.Client
}

var ErrBusy = errors.New("已有操作执行中")
var ErrObserver = errors.New("旁观模式：拒绝停止或替换不属于本实例的服务，请显式确认接管")

// NewManager 接收入口已校验的配置，取得单实例锁并恢复状态；不会自动接管已有进程。
func NewManager(c Config, t Timing) (*Manager, error) {
	if t.Startup <= 0 || t.Poll <= 0 || t.Check <= 0 || t.Stop <= 0 ||
		t.Health <= 0 || t.Recheck <= 0 || t.Stable <= 0 || t.Quiet <= 0 {
		return nil, fmt.Errorf("时序必须为正数")
	}
	if err := os.MkdirAll(c.Home, 0700); err != nil {
		return nil, err
	}
	if err := checkPlainPath(c.Home); err != nil {
		return nil, err
	}
	instanceName := winproc.Name(c.Home, "instance")
	instance, err := winproc.Lock(instanceName)
	if err != nil {
		return nil, err
	}
	for _, dir := range []string{"logs", "ops", "releases", "tmp"} {
		path := filepath.Join(c.Home, dir)
		if err = os.MkdirAll(path, 0700); err != nil {
			instance.Close()
			return nil, err
		}
		if err = checkPlainPath(path); err != nil {
			instance.Close()
			return nil, err
		}
	}
	logPath := filepath.Join(c.Home, "logs", "shell.log")
	logger, err := logging.New(logPath, 5<<20, 5)
	if err != nil {
		instance.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	loopCtx, loopCancel := context.WithCancel(context.Background())
	m := &Manager{
		Config:     c,
		timing:     t,
		ops:        make(map[string]Operation),
		instance:   instance,
		logger:     logger,
		ctx:        ctx,
		cancel:     cancel,
		loopCtx:    loopCtx,
		loopCancel: loopCancel,
		client:     localClient(t.Health),
	}
	statePath := filepath.Join(c.Home, "state.json")
	recovered, err := storage.ReadJSON(statePath, &m.state)
	if err != nil && !os.IsNotExist(err) {
		m.Close()
		return nil, fmt.Errorf("状态不可恢复，拒绝覆盖：%w", err)
	}
	if recovered {
		m.log("状态主文件损坏，已从 .bak 恢复")
	}
	for _, id := range []string{m.state.Current, m.state.Previous, m.state.LastGood} {
		if id != "" && !validID(id) {
			m.Close()
			return nil, fmt.Errorf("状态含无效版本标识")
		}
	}
	//G 磁盘 PID 不能作为归属授权；即使上一实例的子进程还活着，也只旁观。
	listeners, err := winproc.Listeners(c.Ports.Official)
	if err != nil {
		m.Close()
		return nil, err
	}
	m.state.Mode = "idle"
	m.state.Official = nil
	m.state.HealthySince = time.Time{}
	if m.state.Candidate != nil {
		pending := m.state.Candidate
		if e := winproc.Validate(*pending); e != nil {
			m.state.Candidate = nil
		} else {
			m.state.LastError = "上一实例候选仍存在，未自动接管；需按记录身份人工处理后再部署"
			m.log(m.state.LastError)
		}
	}
	if len(listeners) > 0 {
		m.state.Mode = "observer"
		m.state.LastError = "端口已有进程，未接管"
		m.log("检测到已有正式端口监听者，进入旁观模式")
	}
	if err = m.save(); err != nil {
		m.Close()
		return nil, err
	}
	return m, nil
}

func localClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:             nil,
			DisableKeepAlives: true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Snapshot 返回独立状态副本，不暴露令牌或持有的进程句柄。
func (m *Manager) Snapshot() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.state
	if s.Official != nil {
		value := *s.Official
		s.Official = &value
	}
	if s.Candidate != nil {
		value := *s.Candidate
		s.Candidate = &value
	}
	return s
}

func (m *Manager) mutate(change func(*State)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	change(&m.state)
	m.state.UpdatedAt = time.Now().UTC()
	err := storage.WriteJSON(filepath.Join(m.Config.Home, "state.json"), m.state)
	if err != nil {
		m.state.Mode = "error"
		m.state.LastError = "状态持久化失败：" + err.Error()
	}
	return err
}
func (m *Manager) save() error { return m.mutate(func(*State) {}) }
func (m *Manager) log(text string) {
	fmt.Fprintf(m.logger, "%s %s\n", time.Now().Format(time.RFC3339Nano), logging.Redact(text))
}

func (m *Manager) lockAction() (io.Closer, error) {
	if !m.action.TryLock() {
		return nil, ErrBusy
	}
	lock, err := winproc.Lock(winproc.Name(m.Config.Home, "operation"))
	if err != nil {
		m.action.Unlock()
		return nil, ErrBusy
	}
	return lock, nil
}

func (m *Manager) unlockAction(lock io.Closer) { lock.Close(); m.action.Unlock() }

// Begin 异步提交一个操作；锁在返回 op_id 前已获取，不能通过时间戳抢占。
func (m *Manager) Begin(kind string, req Request, confirmed bool) (string, error) {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	if m.closing {
		return "", fmt.Errorf("壳子正在退出")
	}
	if kind != "deploy" && kind != "rollback" && kind != "restart" && kind != "adopt" {
		return "", fmt.Errorf("未知操作")
	}
	if kind == "adopt" && !confirmed {
		return "", fmt.Errorf("接管必须 confirm=yes")
	}
	lock, err := m.lockAction()
	if err != nil {
		return "", err
	}
	if m.ctx.Err() != nil {
		m.unlockAction(lock)
		return "", fmt.Errorf("壳子正在退出")
	}
	if kind != "adopt" && m.Snapshot().Mode == "observer" {
		m.unlockAction(lock)
		return "", ErrObserver
	}
	id := uniqueID()
	//M 操作状态先构造完整，再写入索引和日志。
	logPath := filepath.Join(m.Config.Home, "logs", "swap_"+id+".log")
	op := Operation{
		ID:        id,
		Kind:      kind,
		Stage:     "accepted",
		Status:    "running",
		StartedAt: time.Now().UTC(),
		LogPath:   logPath,
	}
	if err = storage.WriteJSON(filepath.Join(m.Config.Home, "ops", id+".json"), op); err != nil {
		m.unlockAction(lock)
		return "", err
	}
	m.mu.Lock()
	m.ops[id] = op
	m.active = id
	m.mu.Unlock()
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer m.unlockAction(lock)
		writer, openErr := logging.New(op.LogPath, 5<<20, 5)
		operationErr := openErr
		if openErr == nil {
			operationErr = m.execute(kind, req, func(stage, text string) { m.stage(id, stage, text, writer) })
			writer.Close()
		}
		m.mu.Lock()
		done := m.ops[id]
		m.mu.Unlock()
		done.FinishedAt = time.Now().UTC()
		done.Status = "succeeded"
		if operationErr != nil {
			done.Status = "failed"
			done.Error = logging.Redact(operationErr.Error())
		}
		done.Stage = "finished"
		if e := storage.WriteJSON(filepath.Join(m.Config.Home, "ops", id+".json"), done); e != nil {
			done.Status = "failed"
			done.Error = "操作结果持久化失败：" + e.Error()
			m.log(done.Error)
		}
		m.log(fmt.Sprintf("操作 %s %s：%s", id, kind, done.Status))
		m.report(req.SessionID, done)
		m.mu.Lock()
		m.ops[id] = done
		m.active = ""
		m.mu.Unlock()
	}()
	return id, nil
}

func (m *Manager) stage(id, stage, text string, w io.Writer) {
	fmt.Fprintf(w, "%s [%s] %s\n", time.Now().Format(time.RFC3339Nano), stage, logging.Redact(text))
	m.mu.Lock()
	op := m.ops[id]
	op.Stage = stage
	m.ops[id] = op
	m.mu.Unlock()
	if err := storage.WriteJSON(filepath.Join(m.Config.Home, "ops", id+".json"), op); err != nil {
		m.log("阶段保存失败：" + err.Error())
	}
}

// GetOperation 读取内存或磁盘操作，重启前未完成的操作明确标为 interrupted。
func (m *Manager) GetOperation(id string) (Operation, error) {
	if len(id) > 100 || stringsUnsafeID(id) {
		return Operation{}, os.ErrNotExist
	}
	m.mu.Lock()
	op, ok := m.ops[id]
	m.mu.Unlock()
	if !ok {
		_, err := storage.ReadJSON(filepath.Join(m.Config.Home, "ops", id+".json"), &op)
		if err != nil {
			return op, err
		}
		if op.Status == "running" {
			op.Status = "interrupted"
			op.Error = "前一壳子实例退出，操作未完成"
		}
	}
	path := filepath.Join(m.Config.Home, "logs", "swap_"+id+".log")
	tail, err := logging.Tail(path, 200)
	if err == nil {
		op.Tail = logging.Redact(tail)
	}
	return op, nil
}
func stringsUnsafeID(id string) bool {
	if id == "" {
		return true
	}
	for _, r := range id {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_' || r == '.' || r == '-') {
			return true
		}
	}
	return id == "." || id == ".."
}

// StartGuard 启动守护循环；操作执行时跳过，不与换版抢进程。
func (m *Manager) StartGuard() {
	m.lifecycle.Lock()
	defer m.lifecycle.Unlock()
	if m.closing {
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		ticker := time.NewTicker(m.timing.Check)
		defer ticker.Stop()
		if err := m.Tick(time.Now()); err != nil && !errors.Is(err, ErrBusy) {
			m.log("启动守护检查：" + err.Error())
		}
		for {
			select {
			case <-m.loopCtx.Done():
				return
			case <-ticker.C:
				if m.loopCtx.Err() != nil {
					return
				}
				if err := m.Tick(time.Now()); err != nil && !errors.Is(err, ErrBusy) {
					m.log("守护检查：" + err.Error())
				}
			}
		}
	}()
}

// Close 停止壳子内部工作并关句柄；刻意不终止任何服务 Job。
func (m *Manager) Close() error {
	m.closeOnce.Do(func() {
		m.lifecycle.Lock()
		m.closing = true
		m.loopCancel()
		m.lifecycle.Unlock()
		//M 退出不把上下文取消伪装为健康失败；已接受的切换/守护有界完成后再关句柄。
		m.wg.Wait()
		m.action.Lock()
		defer m.action.Unlock()
		m.cancel()
		if m.official != nil {
			m.official.Close()
		}
		if m.candidate != nil {
			m.candidate.Close()
		}
		for _, p := range m.pendingJobs {
			if e := p.Stop(m.timing.Stop); e != nil {
				m.log("退出时检查Job未停止：" + e.Error())
			}
			p.Close()
		}
		if m.instance != nil {
			m.instance.Close()
		}
		if m.logger != nil {
			m.logger.Close()
		}
	})
	return nil
}
