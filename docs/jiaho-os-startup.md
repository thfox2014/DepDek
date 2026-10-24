# 家合开机入口（2026-10-23）

## 当前默认方案

Debian 13 Trixie 默认启动 KDE Plasma 6 的 X11 桌面，不自动打开家合。用户可从桌面快捷方式或应用菜单手动启动「家合 AI-OS」；它以普通窗口运行，不强制全屏或固定分辨率。显示管理器仍是 LightDM，不安装 SDDM；原来的 `jiaho` 最简会话保留作可选恢复入口。

默认中文输入为 Fcitx5 简体拼音：系统通过 `im-config` 选定 Fcitx5，新建 Linux 用户从 `/etc/skel/.config/fcitx5/profile` 继承英文键盘与拼音配置。Ctrl+Space 切换中英文，GTK3 和 Qt6 前端分别服务家合 WebKit 界面和 Plasma 控件。

Plasma 空闲内存 **800–1100 MB** 是设计预算，尚未对新版镜像实测；验收时应分别记录 Plasma、家合和本地模型占用，不把桌面预算当作整机总内存。

## 用户看到什么

开机 Logo → KDE Plasma X11 桌面 → 用户手动打开「家合 AI-OS」→ 首次初始化（账户、网络、模型）／再次登录 → 悟空主界面（左侧入口、中间聊天、右侧操作面板）。用户可以先在 KDE 检查网络、屏幕分辨率和外设，再按需进入家合。

开机先显示完整桌面，不把家合覆盖在登录后的屏幕上；无需输入命令，快捷方式可从桌面或应用菜单打开。网络或模型未就绪仍可进入配置界面。现有账户、模型和文件保留；重启仍要求私人空间登录，Linux 显示会话自动登录不等于家合业务认证，更不是磁盘加密或多用户隔离的替代。

## 启动链路

1. `graphical.target` 拉起 LightDM。`jiaho-session-user.service` 排在 live-config 创建 Live 用户之后、LightDM 之前；只从现有普通 Linux 账户清单选择显示用户，不读浏览器声明或业务角色。
2. `select-session-user` 设置 `autologin-session=plasmax11` 和 `user-session=plasmax11`，使用 Debian Trixie 提供的 Plasma X11 会话；LightDM 仍负责显示登录会话。
3. KDE 不配置家合 XDG 自动启动。应用菜单的 `/usr/share/applications/jiaho.desktop` 和新用户桌面上的快捷方式都运行 `/usr/local/bin/jiaho`；该入口不设置 `JIAHO_OS_SESSION`，因此家合按普通桌面窗口打开，可由 KDE 窗口管理器移动、缩放和最大化。
4. 系统 `im-config` 选择 Fcitx5，新用户从 `/etc/skel/.config/fcitx5/profile` 得到简体拼音默认配置。旧的 `jiaho` 最简 X11 会话仍可在 LightDM 中选择；它退出或失败后会回落到 Plasma。
5. 原有 `AiOsEntry` 和 Vault 登录门禁保持；无新业务 API、无秘密 argv、无自动云端请求。

## 退出、失败与维护

- 正常关闭应用（窗口管理器 `Alt+F4`）：留在 Plasma 桌面，可打开 Dolphin、终端、网络设置或安装器；家合不会自动重新打开。
- 默认 Plasma 会话不监督/无限重启家合。旧 `jiaho` 恢复会话异常退出时，间隔 2 秒、4 秒最多重试三次，再回落到 Plasma。
- Plasma 桌面双击「家合 AI-OS」快捷方式，或从应用菜单搜索「家合」，即可打开；也可在终端执行 `jiaho`。在本地 TTY 执行 `jiaho` 则启动独立恢复图形会话，禁止 root 启动。桌面分辨率通过 KDE「系统设置 → 显示与监视器」调整，家合不会覆盖该设置。
- 原有 GRUB 文本恢复入口 `systemd.unit=multi-user.target` 保留。系统服务不因界面关闭停止，磁盘、网络、后台服务仍由 Linux 管理。
- 自动登录的是本地 Linux 图形会话；家合业务登录仍由应用单独处理。选择 LightDM 中独立的 Jiaho 恢复会话时会直接进入家合体验，默认启动流程不会选择该会话。

## 打包与升级

`os/live/config/package-lists/depdek.list.chroot` 安装 Plasma、LightDM、Fcitx5 拼音和 GTK3/Qt6 前端，不安装完整 KDE 套件或 SDDM。Live hook 设置系统输入法、把家合快捷方式放进新用户桌面，并校验会话与服务。安装到硬盘时这些根文件系统配置随镜像保留，启动时根据目标机的普通 Linux 账户重新生成 Plasma 会话选择。

完整构建（包括 Debian 包、内核或基础依赖变化）：

```sh
bash os/build-mvp.sh
```

已有 Debian 13 基础镜像、依赖齐全且仅更新应用和本次固定启动配置时，可在同一特权 amd64 构建容器使用：

```sh
bash os/repack-app.sh BASE.iso NEW.deb OUTPUT.iso --with-startup
```

该模式将新编译的 Linux deb 和 `os/install-startup.sh` 白名单内的启动文件放入临时根文件系统，校验原生二进制 SHA256、desktop 文件、模型与离线语音，再重建 SquashFS、校验清单和 BIOS/UEFI 启动布局。它不升级 Debian 包或内核，不等于全量系统安全更新。无 `--with-startup` 时仍只更新应用；两种方式均须单独进行新 ISO 启动测试。不会覆盖旧 ISO、格式化 U 盘、重启既有虚拟机或清空旧 Live 数据。

低磁盘构建可选择 `DEPDEK_ROOTFS_TMPFS=1`，只把临时解包树放入 5 GiB tmpfs，容器须至少有 6 GiB 内存预算；输出前额外保留 1 GiB 磁盘空间，不自动清理旧镜像或宿主构建缓存。

## 验证状态

- `npm run test:os-startup`：隔离脚本测试覆盖 Plasma 默认会话、Root/非法用户名拒绝、手动窗口化启动、恢复会话退出、崩溃重试上限、D-Bus 补建、TTY 入口和登录门禁分离。只运行临时假 OS 命令，不写开发主机 `/etc`，不启动真实图形服务。
- `os/test-rootfs.sh`：校验镜像内 Plasma/Fcitx5 软件包、默认拼音 profile、系统输入法、桌面/应用菜单启动器、没有家合自动启动项和已有模型/安装器。
- `os/test-iso.sh`：从 Live TTY 检查 `plasmashell` 已就绪、家合未自动运行、本地模型健康，并检查图形画面至少 1280×720；保留截图供复查。`DEPDEK_KEEP_VM=1` 仅在成功时保留本次测试 VM，`DEPDEK_BOOT_OUTPUT_DIR` 限定在构建产物目录。
- **2026-10-20 旧镜像记录**：当时以前端、sidecar 与 Linux Rust release 生成 amd64 deb，并以 Wukong Debian 13 最简会话 ISO 重制。产物在 `os/artifacts/jiaho-autostart-20261020-202222/`。这是本次 Plasma/Fcitx5 配置之前的镜像，不验证当前默认桌面。
- 该旧 ISO 曾在独立 QEMU x86_64 BIOS Live 虚拟机启动，4 GiB、2 vCPU、禁用 AVX/AVX2/FMA/F16C/BMI2。其 Jiaho 初始化页面、窗口全屏、LightDM、模型服务和离线 Vosk 均通过当时检查；不能据此推断 Plasma/Fcitx5 新配置已在镜像中启动。
- 当前源代码的 9 项启动脚本测试已通过。现存 ISO 仍是此前自动全屏启动家合的镜像（SHA256：`b8846d73a7505502504e5046f5439605e240df5cfbedef19babe633aa7ed7c27`），本次新版 ISO 尚未生成。
- **本次构建未完成**：构建容器的 `python3 -m pip wheel` 在 rootfs 创建前因 `ModuleNotFoundError: No module named 'typing'` 退出；构建环境随后无响应，宿主可用空间约 165 MiB。构建脚本已改用 Debian 系统解释器 `/usr/bin/python3`，待 Docker 恢复且有足够空间后重跑 rootfs 与 QEMU 验收。
- 之前记录的 `28baaea5ee70db92c38b0260d2e8d35aa737f4864236f4116cb5121eac0f23da` 是更早镜像的校验值，不代表当前 `DepDek-AI-OS-amd64.iso`。
- **仍未验收**：真实硬件与 USB 启动、实际 UEFI 启动、目标磁盘安装、重启后的账号/数据持久化、端到端注册登录聊天、真实云端模型和长时间稳定性。本次没有创建真实 BitBay 账号、配置云端密钥或更改宿主私人数据。模型健康不等于已验证推理效果；Live VM 数据未持久化。

软件包依据：Debian Trixie 的 [Plasma X11 会话](https://packages.debian.org/trixie/plasma-workspace)、[Fcitx5 中文扩展](https://packages.debian.org/trixie/fcitx5-chinese-addons)，以及 Debian [`im-config` 手册](https://manpages.debian.org/trixie/im-config/im-config.8.en.html) 与 [Fcitx5 设置说明](https://fcitx-im.org/wiki/Setup_Fcitx_5)。
