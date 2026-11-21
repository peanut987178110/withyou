# WithYou

一个 18+ 的 AI 陪伴产品 MVP。单人、单伴侣、文字聊天，记忆按条征得同意后长期保存，
每天三件小事换经验值，2D 衣橱和房间做轻量表达，订阅解锁更高的对话额度。
支持**交错对话**、**语音条**和**实时语音通话**。

英文优先（产品默认英文），文档、注释、测试报告用中文。

---

## 语言切换

十种语言，界面按**母语名**列出：English / 简体中文 / 繁體中文 / 日本語 / 한국어 /
Español / Français / Deutsch / Português / العربية（阿拉伯语为 RTL）。

**首次打开按设备语言自动选中**：`navigator.languages` 取第一个能识别的标签，
`zh-CN → zh`、`zh-TW/HK/MO → zh-TW`、`pt-BR → pt`，认不出的落回 `en`。
这一步**不写 localStorage**——"从没选过"和"选过英文"是两种状态，写了就再也
不会跟随系统语言。真正选过之后，设备选择优先于账号上的语言。

选择器里每一行除了语言名，还有**一句伴侣真的会说的话**（`/meta` → `locales`，
取自后端同一套台词包）。让人挑的是"伴侣的声音"，只列十个族名等于让人猜。
每行用 `lang` / `dir` 标注自己，所以阿拉伯语样本在英文界面里也是从右往左读。

两个入口：欢迎页底部的语言胶囊（**登录之前**就能换）和「我的」页的设置组。
切换是原地重绘——当前页面不动、不刷新，`<html lang/dir>` 同步更新，选择存
`localStorage` 并同步到账号（`PATCH /settings/locale`），所以换设备后后端仍然
用用户的语言回复。首屏的加载文案也按已选语言绘制，不是先闪一句英文。

RTL 只镜像**字形**（返回箭头、箭头图标），不镜像布局：flexbox 在 `direction: rtl`
下本来就会把第一个子元素放到右边，再加 `row-reverse` 会把顶栏翻第二次。
这条以前是真错了，现在浏览器与模拟器各有断言量返回键的位置。

后端 `backend/app/locales.py` 存十套台词包（开场、共情、追问、记忆问答、
危机与边界台词、通话开场、静默阶梯、回电留言）、关键词表和记忆抽取正则；
缺句退化为英文而不是报错。
可持久化的值（举报原因、各种 id、记忆原文）**始终是英文**，只有显示串被翻译。

安全与危机台词已翻译，但按文档要求仍需母语者审校（界面里有这句提示）。

---

## 语音

两层，共用一套分钟数：**语音条（T4）** 和 **实时通话（T1/T2/T3）**。

**语音条**在聊天页输入框左边的麦克风。录完会先问一句"这条说了什么"——这个版本
没有语音识别，转写是用户自己填的，界面也不假装能听。转写让这条语音变成一轮
对话，伴侣能接话；不填也能发，只是不会得到回复。
气泡里可以播放、看进度、删除；30 天后过期。

**通话**分三种：

| | 谁发起 | 规则 |
| --- | --- | --- |
| T1 | 用户 | 设置里通话开着就能打 |
| T2 | 伴侣 | 首次通话之后，且账号满 72 小时；最多每天一次、每月四次 |
| T3 | 伴侣 | 电话没接 → 30 秒后转成未接 + 一条 ≤20 秒的留言，每月最多两条 |

计费按秒、10 秒起，**静默不超过通话时长 40% 的部分不计费**。免费每月 3 分钟，
Plus 60 分钟，可另买 10 分钟包（不自动续费）。没有硬性挂断：剩余 10% 时伴侣
会开口说，然后收尾。未成年人模式上限 5 分钟、22:00–08:00 不许来电。

伴侣不会在你不希望的时候打过来：11 条禁拨规则（关掉通话、偏好不接、未成年、
账号太新、工作日白天、拒接后沉默、今天已经聊了很久、最近举报过、48 小时最小间隔、
每日上限、自适应退避）。这些都在后端 `voice.prohibition()` 里判，不在 UI——
UI 能被绕过。

通话页有自己的三种状态（响铃 / 通话中 / 已结束）和通话详情页（时长、扣了哪几档
分钟、逐句转写）。结束通话不会跳走，而是原地变成收据，因为"挂断后去哪"本身
是个问题，收据就是答案。

"进通话页"和"想打电话"被拆成了两件事。挂断后从聊天返回通话页，看到上次的收据
是对的；但同一时刻点"打电话"必须真的拨号。两者用同一个路由，靠到达路由推断意图
就会把后者做成前者（这个 bug 真实发生过，视觉探针第一次跑就抓到了）。
所以意图现在是显式的：`startNewCall()` 先清会话再进路由，Voice 页的 Start call
和 Space 的通话瓦片都走它；如果通话仍在进行，则恢复那通电话而不是把它丢掉——
离开页面去改个设置，不该悄悄留下一通还在计费的会话。

---

## 消息交错

三条消息连发，以前会变成"三个问题 + 底部堆三条回复"，回复和问题对不上。

根因是一个全局的待回复槽位：发第二条时，第一条的回复节点被同一个槽位覆盖掉。
现在每条发出的消息**自己拥有自己的回复**——消息一落库就在它下面插一个占位气泡，
那条回复只往自己的占位里流。没有共享槽、没有 `#typing-host` 可以清空，
所以 `U A U A U A` 是结构决定的，不是靠时序碰运气。

浏览器 E2E 里有一条专门复现原 bug 的断言（连发三句，读最后六条的角色序列），
模拟器上也有一条。顺带修掉了 `voice.*` 三个漏传 `{name}` 的调用
（通话列表、详情页眉、开始通话按钮会直接显示字面量 `{name}`），
`scripts/placeholder-scan.mjs` 用来扫这类问题。

---

## 目录

| 路径 | 内容 |
| --- | --- |
| `00_…docx` ~ `11_…docx` + `WithYou_实施文档全集_v2.1_最终复核版.docx` | 产品文档全集（需求、原型、台词、奖励、接口、测试、Prompt、RAG、工具权限、工作流、排期） |
| `app-ui/` | 静态手机 UI 逐页稿（16 页），是视觉基准 |
| `backend/` | FastAPI 后端 + 内置 SQLite，确定性 mock AI |
| `web/` | 前端（原生 ES modules，无框架、无构建） |
| `app-shell/` | Capacitor 6 + Chaquopy 安卓壳，把 Python 后端和前端一起打进 APK |
| `e2e/` | 两套端到端测试：浏览器（`run.mjs`）与真机/模拟器（`device.mjs`），外加 i18n 门禁与两个视觉探针（`probe-*.mjs`） |
| `scripts/` | 一次性检查与内容生成（`placeholder-scan.mjs`、`voice-i18n*.mjs`） |
| `screenshots/` | 测试过程中自动截的图 |
| `dist/` | 发布产物，**不入库**：`withyou.bundle`（完整 git 历史）与 `上传说明.md`，给"换台电脑上传"用 |
| `docs/` | 实施记录（见 `docs/` 下的说明） |

## 跑起来

### 最简单：双击 `start-withyou.cmd`

在项目根目录双击它，会起服务并自动打开浏览器（服务真起来之后才开页面）。
关掉那个黑窗口就停了。

> 直接双击 `web/index.html` 是**打不开**的：浏览器不允许 `file://` 页面加载
> ES module（`js/app.js` 会被 CORS 拦掉），页面会一直停在 "Opening WithYou…"。
> 现在这种情况会直接显示这段说明，而不是无限转圈。

### 手动

先装依赖（Python 3.12；只需一次）：

```bash
cd F:/withyou
pip install -r backend/requirements.txt
```

再起服务：

```bash
cd F:/withyou
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8765
# 浏览器打开 http://127.0.0.1:8765
```

后端会在同一个端口上把 `web/` 作为静态站点挂到根路径，`/api/v1/*` 是接口，
`/healthz` 用于探活。数据库落在 `backend/data/withyou.db`，首次启动自动建表并播种演示账号。

演示账号：`alex@withyou.demo` / `demo1234`。

### 安卓（模拟器或真机）

```bash
cd F:/withyou/app-shell
node scripts/sync-web.mjs                 # 把 web/ 与 backend/ 同步进 APK 的 assets/python
npx cap sync android
cd android && ./gradlew assembleDebug     # 产物在 app/build/outputs/apk/debug/
```

APK 里带着 Python 3.12（Chaquopy），启动时在**进程内**起 uvicorn，监听
`127.0.0.1:8791`，WebView 从 APK assets 加载前端，因此断网也能用。

> 8791 而不是 8765：共享设备上另一个演示 App 已经占了回环的 8765。

## 测试

### 1. 后端单元/验收

```bash
cd F:/withyou/backend && python -m pytest -q
# 78 passed
```

`tests/test_voice.py` 覆盖 T1/T2/T3/T4 的全部规则条目（R-4.1 ~ R-4.8），
触发引擎的时钟用 `voice.set_clock()` 冻结——那组规则全是关于"现在几点"的，
靠真实时间跑会随当天是周几而绿或红。

### 2. 多语言完整性（不需要起服务）

```bash
cd F:/withyou
node e2e/i18n-check.mjs
```

三件事各有一条断言：十份字典的**键、键序、占位符**与 `en.js` 完全一致；
`region.*` / `outfit.*` / `level.*` 这些按 id 查的键族每种语言都齐；**服务端和
客户端能产出的每一个错误码**都有 `apiError.<CODE>` 译文。缺键不会崩（`t()` 退化成
英文），所以它只会悄悄退回英文——正因如此才要断言。

当前结果：**I18N OK — 10 locales, 701 keys, 22 error codes**。

另有一个不属于测试套件的检查：

```bash
node scripts/placeholder-scan.mjs     # 0 placeholder problem(s)
```

它找的是另一种漏：键存在、但调用处没传它声明的占位符。这种不会让 i18n 门禁失败，
只会让用户看到字面量 `{name}`——`voice.startCall` 等三处就这么漏过。

### 3. 浏览器端到端 + 全量可点性审计

```bash
cd F:/withyou
node e2e/run.mjs            # 默认 http://127.0.0.1:8765，可传 baseUrl
```

除了走完首跑主流程，它会在每个页面枚举**所有**可交互控件并逐个点击，
凡是没有引起跳转 / 请求 / DOM 变化 / toast 的，记为 dead control；
控制台报错、失败请求也一并计入失败。

当前结果：**97 passed, 0 failed, 0 deadControls, 0 consoleErrors**，
0 失败请求、0 冲突（`/shop` 余额不足会返回 409，所以断言只买得起的那件）。

### 4. 模拟器端到端（真实触摸 + 真实 IME）

```bash
export ADB="C:/Users/zhentao.pang.wb/AppData/Local/AndroidSdk/platform-tools/adb.exe"
"$ADB" -s emulator-5556 shell am start -n app.withyou.demo/.MainActivity
PID=$("$ADB" -s emulator-5556 shell pidof app.withyou.demo | tr -d '\r')
"$ADB" -s emulator-5556 forward tcp:9333 localabstract:webview_devtools_remote_$PID

cd F:/withyou && node e2e/device.mjs
```

走的是 CDP（`e2e/cdp.mjs`，手写的极简客户端）。Playwright 的 `connectOverCDP`
在这里用不了——WebView 的 devtools 端点只有页面级 target，不支持 `Browser.*`。

点击用 `Input.dispatchTouchEvent`（与手指同一条输入管线，浏览器自己合成 click、
走命中测试），输入用 `Input.insertText`。每次点击前会在页面内完成
「失焦收键盘 → 等视口高度连续三帧不变 → scrollIntoView → 采样命中测试」，
任何一步算出的点若被别的元素挡住，直接报错而不是假绿。

当前结果：**115 passed, 0 failed, 0 consoleErrors, 43 张截图**，
报告写在 `e2e/device-report.json`。

这一层里有几条断言专门盯着真实缺陷，不许假绿：

- 连发三句后，最后六条必须是 `U A U A U A`——每条消息的回复在它自己下面。
- 通话顶部在接通后必须不再显示 "Calling…"（它曾经整通都写着这三个字，
  因为只有路由挂载时画过一次）。
- 挂断后停在收据上，且收据里有数字。
- **挂断后再点一次"打电话"必须真的拨号**，而不是把上一通的收据再画一遍。
- 买完衣服，accent 边框必须跟着移到新穿上那件（它曾经留在旧的那件上）。
- 买衣服要**先读余额再挑那件买得起的**——之前按列表顺序抓，30 Lumen 的账号
  永远撞上 35 的套装，"真的买下来并穿上"在模拟器上从没执行过。
- 语言面板十行样本都非空；面板高度不超过视口（最后一行不能被裁掉）。
- 阿拉伯语下返回键在**右**边（`fromRight < fromLeft`），tab 顺序也镜像。

### 5. 视觉探针（版式与 RTL）

```bash
node e2e/probe-voice-rtl.mjs     # 16/16
node e2e/probe-interleave.mjs    # 消息交错：三条连发后 A/U 交替
```

E2E 断言的是行为（"这通电话能挂断成收据"），这个探针断言的是新版式**装得下**：
390×844 下英/阿两种方向都不出现横向溢出、没有元素越过视口边缘、标签没被容器裁掉、
RTL 下返回键在右边。截图落在 `screenshots/probe-*.png`，是用来对照数字的。

当前结果：**16/16 passed**。它第一次跑就抓到上面那条"再拨一次"的缺陷——
数字探针的价值就在这里，肉眼看截图不会注意到那通"新电话"其实没有响。

### 6. Monkey

```bash
"$ADB" -s emulator-5556 shell monkey -p app.withyou.demo \
  --throttle 150 --pct-appswitch 8 --pct-touch 55 --pct-motion 20 \
  --pct-nav 8 --pct-syskeys 4 --pct-anyevent 5 -v 2000
```

结果：**2000 个事件，0 crash，0 ANR**，进程 pid 未变，后端 `/api/v1/meta`
与 `/api/v1/memories` 仍返回 200。（monkey 常把 App 退到桌面，这不影响判读：
重新拉起能直接回到 Home 且状态连贯，就说明进程没崩。）

> 注意：共享机器上有两台模拟器。`emulator-5554` 是用户自己的 `apm` AVD
> （跑 `com.tide.app`），**不要往它上面装东西**；本项目只用 `emulator-5556` / `orbit`。

> monkey 之前先看一眼 `uptime`：模拟器 CPU 被别的进程吃满时，E2E 会以
> "按钮点了没反应"的形式失败，看起来像产品 bug。真遇到时先冷启模拟器再跑。

## 产品骨架

**账号与引导**：注册 → 年龄自证（18+ 与地区）→ 创建伴侣（名字、相处风格、性格标签）。

**聊天**：文字对话，AI 回复带打字指示。**每条消息拥有自己的回复**——连发不会
把回复堆到底部。回复下方有 Copy / Again / Report；举报会弹原因面板并落库。
输入框左边是语音条按钮。

**记忆**：两个**互相独立**的开关——`extraction_enabled` 决定是否从对话里提取候选，
`retrieval_enabled` 决定是否在生成时使用。提取出来的记忆是 `proposed` 状态，
必须用户在聊天里逐条确认才转为 `confirmed`。用户可随时编辑或删除。
`PATCH /settings/memory` 带版本号，版本过期返回 409，前端会重取最新版本再重试。

**奖励**：三个日任务，规则版本 `2026-11-18.1`

| 活动 | 上限 | 奖励 |
| --- | --- | --- |
| `daily_mood_v1` 心情打卡 | 1/天 | XP 10 + Lumen 5 |
| `daily_reflect_v1` 晚间反思 | 1/天 | XP 15 + Lumen 5 |
| `chat_session_v1` 聊天会话 | 3/天 | XP 5 |

XP 只增不减、不可购买；Lumen 只能挣不能买。注册赠送 Lumen 20（`onboarding_v1`）。

**关系等级**：1–5 级，由 XP 驱动，聊天页头部展示。

**空间**：2D 衣橱（`linen_soft` 免费，其余用 Lumen 解锁）、三个房间预设（都免费）、
语音通话入口。

**语音**：语音条（T4）+ 通话（T1/T2/T3），月配额与分钟包见上文「语音」一节。
设置里五个开关：允许通话、偏好不接来电、字幕、保留转写、未成年模式。

**订阅**：`withyou_plus_monthly` $9.99（7 天试用）、`withyou_plus_yearly` $59.99（无试用）。
免费用户每天 50 条回复，Plus 300 条。安全/危机/导出/删除/取消**永不消耗额度**。

**隐私**：导出全量数据（需再输一次密码）、删除账号、退出登录。
导出与删除完成后，面板会真正关闭——这一点曾经是 bug，现在有断言守着。

## 架构要点

- **后端**：FastAPI + 标准库 `sqlite3`，无 ORM。六个 router 按域切分
  （auth / chat / memory / economy / privacy / voice），统一响应包
  `{code, message, data, request_id}`。AI 走 `WITHYOU_AI_MODE=mock` 的确定性实现，
  RAG 是对 `backend/kb/kb.json` 的关键词重叠检索。流式回复用后台守护线程跑，
  进程退出不阻塞。
- **语音规则只在后端**：`backend/app/voice.py`（1082 行）拥有授权链、禁拨规则、
  触发引擎、计费与通话产物；`routers/voice.py` 只做参数到规则的转接。
  `POST /calls` 只接受 `direction=outbound`——T2 的来电只能由触发引擎发起，
  否则频率上限形同虚设。
- **前端**：原生 ES modules，hash 路由，模板用带自动转义的 `html` 标签函数。
  设计令牌集中在 `web/css/app.css`（`--paper:#fbfafc`、`--accent:#5968ef`、
  `--lilac:#c5c7fa`、`--tap:44px`），`#app` 最大宽度 560px。
  每个 screen 都是状态的纯函数，所以换语言不需要刷新，只需要重绘。
- **状态隔离**：账号、消息、记忆、奖励、关系、订单、订阅、通话各自独立；
  换账号时会调 `forgetUserState()` 把会话级残留（包括聊天里待定的记忆提议、
  正在进行的录音和通话计时器）一并清掉——这是修过的一个真实跨账号泄漏。

## 已知取舍

- AI 回复是 mock，不是真实模型；接口契约与真实接入一致。
- 通话是**文字模拟的语音通话**：没有真实音频流，也没有 TTS/ASR。转写由用户在
  发送语音条时自己填，界面里明说这一点，不假装能听。计费、静默阶梯、禁拨规则、
  收据都是真的，换成真实音频只改这一层。
- 来电界面（T2 响铃时的接听/拒接）目前只有后端契约与 `/calls/{id}/answer`，
  App 里没有主动弹出的来电页——AI 主动来电要等推送通道，那是下一版的事。
- 订阅走 mock 支付，不接应用商店；试用/续费/取消状态机是真的。
- 图片资源用内联 SVG，没有位图依赖。