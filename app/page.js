'use client';
import { useEffect, useState } from 'react';

const DEMO_COMMANDS = [
  '批改这次提交的作业',
  '为什么这份作业只得了这么低的分？',
  '生成这次作业的学情分析',
  '谁这周状态下滑？列个预警名单',
  '给分数最低的 5 个学生生成个性化练习',
];

export default function Page() {
  const [tab, setTab] = useState('grade');
  const [assignments, setAssignments] = useState([]);
  const [assignmentId, setAssignmentId] = useState('A1');
  const [text, setText] = useState(
    'def binary_search(arr, target):\n    # 二分查找，返回下标，不存在返回 -1\n    left, right = 0, len(arr) - 1\n    while left <= right:\n        mid = (left + right) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            left = mid + 1\n        else:\n            right = mid - 1\n    return -1\n# 时间复杂度 O(log n)，空间 O(1)'
  );
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('');

  const [message, setMessage] = useState('');
  const [chat, setChat] = useState([]);
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    fetch('/api/grade')
      .then((r) => r.json())
      .then((d) => setAssignments(d.assignments || []))
      .catch(() => {});
  }, []);

  async function doGrade() {
    setLoading(true);
    setResult(null);
    const res = await fetch('/api/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, assignmentId }),
    }).then((r) => r.json());
    setResult(res);
    setMode(res?.result?.mode || '');
    setLoading(false);
  }

  async function send(msg) {
    const content = (msg ?? message).trim();
    if (!content) return;
    setChat((c) => [...c, { role: 'user', content }]);
    setMessage('');
    setThinking(true);
    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: content }),
    }).then((r) => r.json());
    setThinking(false);
    setChat((c) => [...c, { role: 'ai', content: res.reply || res.error, tool: res.tool, data: res.data }]);
  }

  return (
    <div className="wrap">
      <div className="header">
        <h1>ClassPilot 智课领航员</h1>
        <span className="slogan">教师说人话，AI 干重复活 —— 每份批改都带证据可申诉</span>
        {mode && <span className="badge">模型模式：{mode}</span>}
      </div>

      <div className="tabs">
        <button className={tab === 'grade' ? 'tab active' : 'tab'} onClick={() => setTab('grade')}>
          批改工作台
        </button>
        <button className={tab === 'agent' ? 'tab active' : 'tab'} onClick={() => setTab('agent')}>
          对话式入口（Agent）
        </button>
      </div>

      {tab === 'grade' ? (
        <>
          <div className="card">
            <div className="row">
              <select value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)}>
                {assignments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id} · {a.title}
                  </option>
                ))}
              </select>
              <span className="muted">粘贴作业文本，或上传后由后端解析（C 同学负责）</span>
            </div>
            <textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row" style={{ marginTop: 12 }}>
              <button onClick={doGrade} disabled={loading}>
                {loading ? 'AI 批改中…' : '开始批改'}
              </button>
              <span className="muted">目标：30 秒内出结果，且每个维度都带原文证据</span>
            </div>
          </div>

          {result?.result && (
            <div className="grid2">
              <div className="card">
                <h3>总分</h3>
                <div className="score">{result.result.total_score}</div>
                <div className="muted">耗时 {(result.elapsedMs / 1000).toFixed(1)} 秒</div>
                <div style={{ marginTop: 12 }}>
                  <div className="name">总体评语</div>
                  <div className="msg">{result.result.comment}</div>
                </div>
              </div>
              <div className="card">
                <h3>评分明细（证据链）</h3>
                {result.result.dimensions.map((d) => (
                  <div className="dim" key={d.name}>
                    <div>
                      <span className="name">{d.name}</span>
                      <span className="meta">
                        {d.score} / {d.max}
                      </span>
                      {d.confidence === 'low' && <span className="tag-low">待复核</span>}
                    </div>
                    <div className="evidence">原文证据：{d.evidence}</div>
                    <div className="muted">{d.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="card">
            <h3>对话式入口 —— 演示指令（点击即用）</h3>
            <div className="row">
              {DEMO_COMMANDS.map((c) => (
                <span key={c} className="chip" style={{ cursor: 'pointer' }} onClick={() => send(c)}>
                  {c}
                </span>
              ))}
            </div>
          </div>
          <div className="card">
            {chat.map((m, i) => (
              <div key={i}>
                <div className={m.role === 'user' ? 'msg user' : 'msg'}>
                  <b>{m.role === 'user' ? '教师：' : 'ClassPilot：'}</b> {m.content}
                </div>
                {m.data?.distribution && <ReportCard data={m.data} />}
                {m.data?.students && <WarningCard data={m.data} />}
                {m.data?.practices && <PracticeCard data={m.data} />}
              </div>
            ))}
            {thinking && <div className="muted">AI 正在处理…</div>}
            <div className="row" style={{ marginTop: 12 }}>
              <input
                className="chat"
                type="text"
                value={message}
                placeholder="例如：批改这次提交的作业"
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
              <button onClick={() => send()}>发送</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ReportCard({ data }) {
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="row">
        <b>平均分 {data.avg}</b>
        <span className="chip">最高 {data.highest}</span>
        <span className="chip">最低 {data.lowest}</span>
        <span className="chip">待复核 {data.lowConfidence} 份</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>维度</th>
            <th>平均分</th>
            <th>得分率</th>
          </tr>
        </thead>
        <tbody>
          {data.dimensions.map((d) => (
            <tr key={d.name}>
              <td>{d.name}</td>
              <td>
                {d.avg}/{d.max}
              </td>
              <td>{(d.rate * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WarningCard({ data }) {
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <b>预警名单（{data.total} 人）</b>
      <table>
        <thead>
          <tr>
            <th>学生</th>
            <th>本次</th>
            <th>上次</th>
            <th>变化</th>
            <th>等级</th>
          </tr>
        </thead>
        <tbody>
          {data.students.slice(0, 8).map((s) => (
            <tr key={s.studentId}>
              <td>{s.name}</td>
              <td>{s.score}</td>
              <td>{s.prev}</td>
              <td>{s.drop > 0 ? `↓${s.drop}` : `↑${-s.drop}`}</td>
              <td>{s.level}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PracticeCard({ data }) {
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <b>个性化练习</b>
      {data.practices.map((p) => (
        <div className="dim" key={p.studentId}>
          <div>
            <span className="name">{p.name}</span>
            <span className="meta">
              {p.score} 分 · 薄弱点：{p.weakPoint}
            </span>
          </div>
          {p.items.map((it, i) => (
            <div className="muted" key={i}>
              · {it}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
