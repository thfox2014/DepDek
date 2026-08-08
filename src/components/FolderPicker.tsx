import logo from "../assets/depdek-logo.png";

interface Props {
  onPick: () => void;
  error?: string | null;
}

export default function FolderPicker({ onPick, error }: Props) {
  return (
    <div className="folder-picker">
      <div className="card">
        <img className="folder-picker__logo" src={logo} alt="DepDek" />
        <h1>DepDek</h1>
        <p>选择你的本地数据 Home。凭据、记忆和个人数据由你掌控，所有 agent 只能访问该目录，文件操作都会写入审计日志。</p>
        <button className="primary" onClick={onPick}>
          选择本地数据 Home
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
