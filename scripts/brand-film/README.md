# 家合 · 品牌片制作工程

主题：**东西有归处，事情有着落，你可以慢慢说。**

范围：横版 1080p 品牌片初剪，约两分钟，中文合成旁白、内嵌字幕、原创合成轻配乐。不是产品功能验收录像，也不等于小云雀已经调用成功。字幕、脚本与画面明确区分内测界面、虚构示例、兼容工作台与产品愿景。

## 资产与来源

- Logo：原有 `src/assets/jiaho-boot-logo.png`，不重画品牌图形。
- 相册照片：`scripts/fixtures/treasure-assets/` 的既有 AI 生成虚构人物，来源与说明见该目录 README；不使用家庭照片。
- 相册、资料与首启：通过既有隔离预览采集生产组件，服务为明确标记的内存示例；不连接真实账号、Home 或大模型。
- `FileLibraryFilm.tsx`：文件页生产组件，注入仅当前页有效的虚构 API；其记录、大小与哈希不是真实家庭数据，不用于证明原生业务执行成功。
- `WorkbenchFilm.tsx`：原有完整工作台，只展示兼容入口；未连接真实 Provider，未执行外部动作。
- Webdesk：项目内置 `?demo=1`，指标全部为模拟。不得将其容量/性能数字写成产品规格。
- 记忆：`JiahoFirstMilePreview` 的 v0，仅用于明确标注的“产品愿景”，不宣称跨身份记忆、删除、敏感保险箱已经验收。
- 声音：本机 macOS Tingting 合成旁白，用于初剪，不仿冒特定人物。配乐由 `render.py` 使用固定音符与合成包络原创生成，未使用第三方乐曲或采样。正式公开投放前需再检查配音许可、AIGC 标识与所有素材的使用条件。

脚本与分镜以 `scenes.json` 为源。生成物在 `os/artifacts/jiaho-brand-film-20261019/`，该目录沿用项目现有忽略策略，不会将视频打入应用或默认提交 Git。

## 制作方法

使用工具运行时的 Pillow / numpy 和 ffmpeg。仅将 `imageio-ffmpeg` 安装到本次临时目录，没有改动应用依赖或系统 Python。例：

```sh
python3 scripts/brand-film/render.py --ffmpeg /absolute/path/to/ffmpeg --frames-only
python3 scripts/brand-film/render.py --ffmpeg /absolute/path/to/ffmpeg --reuse-audio
```

`--frames-only` 生成全部场景关键帧、总览与海报；完整渲染生成 H.264/AAC MP4、旁白 SRT、时间线、内容哈希。重用声音前会比较旁白文本，变更后自动重新合成。用 `say` 生成初剪声音仅支持本机 macOS，Linux 制作环境需替换配音步骤。

独立文件素材页：`node scripts/brand-film/preview-files.mjs`（14434）；兼容工作台素材页加 `--workbench`（14435）。其它镜头使用现有 preview 脚本。这些服务只监听 loopback，不部署、不替换应用、不修改业务存储。

## 特性覆盖和承诺边界

| 镜头 | 覆盖 | 不能暗示 |
| --- | --- | --- |
| 门与品牌 | 家合 Logo、家庭 AI 中心、Product Soul | 特定 NAS 硬件或未经测试的性能 |
| 四步向导 | 网络、账户、模型、工作模式 | 示例接口已真实连通、积分等于可用云额度 |
| 悟空 | 单角色、文字/语音草稿、深浅模式、按需面板 | 常驻监听、已经读懂全部家庭资料 |
| 文件库 | 用户选取、副本、五类、路径/SHA/KV、来源 | 自动语义理解、无限文件大小、已开放所有终端写入 |
| 资料三场景 | 有界原文检索、PDF、分组/原文比较、清单/资料包 | 自动识别所有格式、LLM 全文回答、自动对外发送 |
| 相册三场景 | 人工标签、完全相同副本、保留标记、日期选片/故事草稿 | 已实现人脸识别/质量评分、可恢复清理或影片导出 |
| 模型与隐私 | 本地/联网模式、自选模型、既有加密凭据入口 | 本地模式为防火墙、敏感资料保险箱已完成 |
| 兼容工作台 | 邮件、日历、待办、Obsidian、自动化、媒体技能入口 | 所有外部连接无需配置，MCP/浏览器电脑无条件可用 |
| Webdesk | 桌面/窗口、文件、存储网络与性能管理 | 模拟数字为实测规格、所有服务已统一数据面 |
| 往后的家 | 认可的记忆、渐进理解、敏感保护的方向 | 愿景已是当前发布功能 |

## 小云雀 API 路径

用户明确选择接口，不走网页登录。已查阅官方：

- [智能生视频 Agent 2.0 产品与服务开通说明](https://docs.volcengine.com/docs/JimengAI/Xiaoyunque-IntelligentLifeVideoAgent20-ProductIntroduction?lang=zh)
- [2.0 有参考接口](https://docs.volcengine.com/docs/JimengAI/Xiaoyunque-IntelligentLifeVideoAgent20Reference-InterfaceDocumentation?lang=zh)
- [2.0 无参考接口](https://docs.volcengine.com/docs/JimengAI/Xiaoyunque-IntelligentLifeVideoAgent20NoReference-InterfaceDocumentation?lang=zh)

核验信息：固定 CV 服务地址 `https://visual.volcengineapi.com`；提交 `CVSync2AsyncSubmitTask`，查询 `CVSync2AsyncGetResult`，版本 `2022-08-31`，区域 `cn-north-1`、Service `cv`。有参考文档的服务标识为 `pippit_iv2v_v20_cvtob_with_vinput`。这些是查阅结果，不代表当前账号有权限或接口已实际调用。

本次当前进程未配置火山 AK/SK，没有读出或借用 DepDek 的 Provider 密钥，没有进行付费提交。需要用户提供已开通对应服务的本机凭据位置及生成预算，再做实际请求。凭据只从用户指定的私有位置读取，不加入本工程、日志、素材包或命令行参数。

建议小云雀只负责 10–15 秒的生活氛围镜头；产品 UI 使用本机真实组件画面，不能让视频模型重新生成界面文字、按钮或不存在的能力。参考素材若需公网 URL，先与用户确定上传对象，不自动把本机文件公开。默认保留服务的 AIGC 标识。提交遇到未知结果时保留 task_id 查询，不盲目重复生成造成重复计费。

`xiaoyunque-opening-prompt.txt` 为不含私人信息的开场提示词；它是准备材料，不是已提交任务。
