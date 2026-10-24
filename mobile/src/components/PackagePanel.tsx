import { Paperclip } from "@phosphor-icons/react";
import type { FamilyPack } from "../lib/types";
import { Button } from "./ui";
import { downloadText } from "./Panels";

export default function PackagePanel({
  pack,
}: {
  pack: FamilyPack | undefined;
}) {
  if (!pack)
    return <p className="caption">当前范围没有这份资料包，请返回家庭档案刷新。</p>;

  return (
    <>
      {pack.stale && (
        <div className="callout attention" role="status">
          家庭资料已变化，这份清单可能过期。请在家合主机更新后再使用。
        </div>
      )}
      <pre className="document-text">{pack.markdown}</pre>
      <Button
        secondary
        disabled={pack.stale}
        onClick={() => downloadText("家合-维修资料包清单.md", pack.markdown)}
      >
        <Paperclip size={18} />
        {pack.stale ? "清单需要更新" : "下载本机清单"}
      </Button>
      <p className="caption">
        这是当前账户获取的资料包文本，不包含原件，不会对外发送。
      </p>
    </>
  );
}
