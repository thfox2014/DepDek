# AI Content Agent · 内容自动标注

图片、视频、文档共用一个后台内容分析器；用户仍只面对悟空。入口统一为「AI 自动标注」，一次点击只分析当前文件，结果自动存到本机文件 KV，显示「AI 生成」并允许修正。模型选择沿用已配置 Provider，缺省使用悟空当前模型；媒体需要支持图片输入的模型，拒绝时明确提示更换视觉模型。

## 处理链路

1. 从当前 library_id + path + SHA 获取已核验原件。图片缩放到最长边 1280；视频抽取最多 6 个均匀分布的画面（含开头和结尾），说明没有分析声音；文本取最多 24000 字；PDF 取前 8 页正文，正文不足时补最多 4 页页面图，保留取样范围。
2. Rust Vault 再次校验登录、Home、索引类别、路径/no-follow、文件大小和 SHA。前端提取的正文/页面/视频帧属于派生证据，绑定这个文件引用，并有严格大小/数量上限；不把前端证据当作服务端独立认证的识别结论。
3. core 按保存的 Provider 名称解析加密凭据，复验联网/本地模式，通过 content/analyze 调用单次、无工具、无个人上下文的模型分析。Content Agent 是共享工作流，模型适配使用现有 Pi SDK；不继承悟空会话的工具、聊天历史或 Harness 权限。一次请求 60 秒，无应用层自动重试。
4. 输出 title、description、tags、observations、uncertainties。画面只能说明可见内容；不能猜姓名、亲属关系、拍摄时间。材料中的指令当内容处理；完整身份证/银行卡/密码不写入普通标注。
5. 模型输出经 sidecar 与 Vault 两次类型、长度校验；完成后重新复验 Home、原件 SHA 和 expectedRevision。存入 content_annotations_v1，人工照片/视频标签独立保留。失败不保存成功标记。重开界面可读，文件改版后旧记录不会附到新 SHA。
6. 名称/路径检索增补 AI 描述和标签检索，命中仍指向原件。AI 标注是派生可纠正信息，不等于用户确认事实或长期记忆。

## 接口与数据

Tauri content_annotation_get({input:{libraryId,reference:{path,sha256}}}) 返回 ContentAnnotation|null。

Tauri content_analyze({input:{libraryId,reference,providerName,evidence,expectedRevision}}) 返回保存后的 ContentAnnotation。

Tauri content_annotation_update({input:{libraryId,reference,expectedRevision,title,description,tags}}) 更新用户修正，返回 source=user_corrected 的记录；模型来源和分析范围保留。

证据 evidence={text,images:[{data,mimeType,label}],coverage}；text 最多 24000 字；images 最多 6 个 JPEG/PNG/WebP，单个解码后最多 1 MiB，总共最多 4 MiB；coverage 为最多 240 字的真实提取范围。视频/PDF 的帧/页标记由前端生成并展示。原始文件仍受照片 12 MiB、视频 64 MiB、文档 16 MiB 限额。

ContentAnnotation={path,sha256,title,description,tags,observations:[{label,value}],uncertainties,coverage,provider_name,model,total_tokens,source,revision,created_at_ms,updated_at_ms}。title≤120 字，description≤1600 字，tags≤12×60 字，observations≤8×(40/300 字)，uncertainties≤6×160 字。source 为 ai 或 user_corrected。KV 位于当前 Home 私有文件索引目录；所有读写、模型处理开始和完成/失败均走 Vault 审计；日志不包含正文/画面/凭据。

core → sidecar content/analyze({provider,evidence,category}) 返回 {title,description,tags,observations,uncertainties,total_tokens}。不注册成 Agent 工具，不接受文件路径工具请求；provider 凭据仅现有 core→sidecar 内部通道，前端只用 Provider 名称。

## 首批范围与验证

首批支持已能本机解码的图片/视频、UTF-8 文本和 PDF。不能解码的格式给出明确状态；Office 原件未接正文解析时不以文件名冒充内容标注。视频仅分析采样画面，不转写音轨；长 PDF 明示取样页数。云端模型只在点击分析时接收本次派生内容，界面显示模型及本地/联网位置。

必须验证：三类入口同一结果结构；错误 JSON 不落盘；模型不支持图片时明确报错；人工标签不覆盖；跨 Home、旧 SHA、越界/符号链接、修订冲突拒绝并审计；模型完成后源文件变化拒绝保存；标签可搜索；重启可读取；用户修正后 source 变化；未点击不发模型请求。
