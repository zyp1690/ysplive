# ysplive · 央视频直播（飞牛 fnOS 原生版）

把 [tmxk2020/ysp-live](https://github.com/tmxk2020/ysp-live)（原本是 Docker + Python/Node 的 OpenWrt 软路由方案）改造成 **飞牛 fnOS 原生 FPK 应用**：不再需要 Docker，装完在桌面点开就是一块电视式的直播界面——左侧频道列表、中间频道信息、右边直播画面，带真实节目单；点两下就能在网页里看直播；右上「管理」进去可以改站点信息、频道名称/分组/地址、加自定义频道；同时照旧对外输出标准 M3U 订阅给电视和播放器。

界面**同时监听 IPv4 与 IPv6**。

- 服务端口：`8767`（网页 + 订阅 + 反向代理）
- 支持架构：`all`（x86_64 / ARM64 通用，纯 Python 标准库实现）
- 依赖应用：`python312`

## 安装

### 方式一：手动安装 FPK

1. 下载 [`ysplive/fpk/ysplive-1.1.5-fnos-all.fpk`](ysplive/fpk/ysplive-1.1.5-fnos-all.fpk)
2. 飞牛「应用中心」→ 右上角手动安装 → 选择该 `.fpk`
3. 安装向导里确认端口（默认 `8767`），完成
4. 回到桌面，点「ysplive 央视频直播」图标

### 方式二：作为 FnDepot 外部应用源添加

本仓库根目录就是一份 **FnDepot V2 规范的 `fnpack.json`**，可以直接把这个仓库地址当成应用源：

```text
https://github.com/zyp1690/ysplive
```

在 FnDepot 的「设置 → 应用源设置 → 添加应用源」中粘贴上面的地址，即可在客户端里看到 ysplive，并能跟随版本更新。也支持直接填 JSON 直链：

```text
https://raw.githubusercontent.com/zyp1690/ysplive/main/fnpack.json
```

> FnDepot 客户端需 ≥ 0.0.7 才支持 V2 源。

## 界面

| 场景 | 说明 |
| --- | --- |
| 三栏界面 | 左频道列表（央视 / 卫视分组、64 路）、中频道信息（正在观看、正在播出、稍后播出、信号来源）、右直播画面 |
| 全屏播放 | 点「立即收看」→ 隐藏顶栏与页脚，画面铺满窗口，必要时一并进入系统全屏 |
| 选台浮层 | 播放中点画面弹出半透明浮层：左侧频道列表 + 中间频道信息，两块合成一张连体卡片；右上「主线路 / 管理 / 全屏 / 收起」 |
| 换台 | 浮层里点一行立刻换台，频道栏随即自动收起，只留频道信息卡；再点画面可重新展开 |
| 收起 | 点画面空白、9 秒无操作、或按 Esc / 「收起」→ 回三栏界面继续播放 |
| 管理 | 三栏顶栏「管理」，或全屏浮层里右上「管理」，直接打开管理抽屉（站点信息、频道编辑、自定义频道、订阅地址） |

深链（方便收藏或直接进播放态）：

```text
/                  三栏界面
/?ch=cctv1         直接全屏播放该频道
/?ch=cctv1&osd=1   播放并展开选台浮层
/?admin=1          直接打开管理抽屉
```

## 订阅输出

| 地址 | 说明 |
| --- | --- |
| `http://NAS:8767/all.m3u` | 合并订阅：内置央视 + 自建频道 |
| `http://NAS:8767/cctv1.m3u8` | 单频道直连线路 |
| `http://NAS:8767/api/play.m3u8?ch=cctv1&proxy=1` | 备用线路（分片经 NAS 反向代理） |

## 仓库结构

```text
ysplive/
├── fnpack.json                  # FnDepot V2 应用源索引（根目录固定文件名）
├── ysplive/
│   ├── ICON.PNG                 # 应用图标 64x64
│   ├── ICON_256.PNG             # 应用图标 256x256
│   ├── README.md                # 应用详情页（FnDepot 客户端内展示）
│   └── fpk/
│       └── ysplive-1.1.5-fnos-all.fpk
├── src/                         # FPK 源码（manifest / cmd / config / wizard / app）
└── .github/                     # 资产落地工作流与声明
```

## 本地重新打包

```bash
cd src
./build-fpk.sh          # 自动下载 fnpack 1.2.3 并产出 ysplive-<version>-fnos-all.fpk
```

## 版权与许可

- 上游程序 © TMXK（大亨分享）· <https://github.com/tmxk2020/ysp-live> · 业务逻辑未作修改
- 飞牛 fnOS 适配部分 © 2026 火舞狂沙
- 详见 FPK 内 `LICENSE.txt`
