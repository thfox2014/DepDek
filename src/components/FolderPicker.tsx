interface Props {
  onPick: () => void;
  error?: string | null;
}

export default function FolderPicker({ onPick, error }: Props) {
  return (
    <div className="folder-picker">
      <div className="card">
        <h1>Agent Workbench</h1>
        <p>请选择一个数据文件夹。所有 agent 只能访问该文件夹内的内容，全部文件操作都会记录审计日志。</p>
        <button className="primary" onClick={onPick}>
          选择数据文件夹
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
