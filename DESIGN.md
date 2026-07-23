---
name: "OrderBridge"
description: "面向企业工作人员的轻量清晰收件箱工具"
colors:
  primary: "#222222"
  primary-strong: "#111111"
  text: "#111827"
  muted: "#6b7280"
  neutral-bg: "#f3f4f6"
  neutral-soft: "#f9fafb"
  surface: "#ffffff"
  line: "#e5e7eb"
  line-strong: "#d1d5db"
  danger: "#b91c1c"
  success: "#166534"
typography:
  title:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.02em"
  body:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "\"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.5
rounded:
  sm: "10px"
  md: "12px"
  lg: "14px"
  xl: "16px"
  shell: "18px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "10px"
  md: "12px"
  lg: "14px"
  xl: "16px"
  xxl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
  button-primary-hover:
    backgroundColor: "{colors.primary-strong}"
    textColor: "{colors.surface}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.shell}"
    padding: "{spacing.xl}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  list-item:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "14px 12px"
---

# Design System: OrderBridge

## 1. Overview

**Creative North Star: "清晰收件箱"**

这个系统的核心不是展示“智能感”，而是把企业工作人员每天面对的真实邮件流，整理成一个可以快速进入任务的收件箱界面。它的设计重点在于让主题、发件人、时间、正文与附件这些真正影响后续处理的信息更快被扫到，而不是通过花哨视觉制造存在感。

整体气质应当保持轻量、清晰、直接。页面使用浅灰背景、白色内容面板、深灰文字和克制的边框系统，让用户感觉这是一个稳定可靠的内部操作工具。分区应该明确，但不应依赖厚重装饰或强悬浮感来表达层级；信息本身、间距和标题结构才是主角。

这个系统明确拒绝 PRODUCT.md 中的几类方向：不要像彩色 AI dashboard 或炫技式“智能工作台”，不要像层级复杂、理解成本高的传统 ERP 页面，也不要过度营销化、装饰化。它应该始终像一个帮助用户读懂邮件、处理任务的工作界面。

**Key Characteristics:**
- 信息优先于装饰
- 纯白内容面板搭配轻灰页面分区
- 深色文字与高对比边框保证可读性
- 组件状态清晰直接，不卖弄动画
- 阅读与操作并重，适合高频办公场景

## 2. Colors

这套配色是典型的 restrained product palette，用中性灰阶和近黑文本建立秩序，只有状态色承担反馈角色。

### Primary
- **控制台墨黑** (`#222222`): 用于主要按钮、关键操作强调和少量高优先级 UI 元素。它承担“行动入口”的角色，而不是装饰性品牌色。

### Secondary
- **深层石墨** (`#111111`): 作为 primary 的压实层，用在按钮渐进加深、重点文字或需要更强存在感的局部控件中。

### Neutral
- **工作区浅灰** (`#f3f4f6`): 页面底层背景色，用于承托整个三栏布局，让内容面板从背景中被自然区分出来。
- **柔和底板灰** (`#f9fafb`): 用于说明框、提示区、卡片标题区等轻量分层位置，适合承载辅助信息。
- **结构白** (`#ffffff`): 所有主要内容面板、列表项、卡片与附件容器的主背景，确保阅读区稳定、清爽。
- **分隔线灰** (`#e5e7eb`): 常规边框和卡片分隔线的主色，用来定义结构但不喧宾夺主。
- **强调线灰** (`#d1d5db`): hover、active 或更清晰边界时使用的加强边框色。
- **正文墨色** (`#111827`): 所有关键正文信息、标题和主要阅读内容的标准文字色。
- **辅助信息灰** (`#6b7280`): 发件人、时间、说明文案和状态辅助文案的标准颜色。

### Named Rules
**The One Accent Rule.** 界面不引入装饰性色彩。除错误和成功等状态反馈外，整个系统只允许近黑灰阶承担强调职责，稀缺和克制本身就是清晰感的一部分。

## 3. Typography

**Display Font:** 无独立展示字体，沿用 `PingFang SC, Microsoft YaHei, sans-serif`
**Body Font:** `PingFang SC, Microsoft YaHei, sans-serif`
**Label/Mono Font:** 与正文一致，不额外引入第二字体

**Character:** 这是一套典型的企业工具型中文界面文字系统。它不追求强展示性，而追求中文阅读稳定、标签清楚、列表信息密度适中，适合用户长时间连续查看邮件内容。

### Hierarchy
- **Title** (700, 18px, 1.4): 用于窗口标题和主要区块标题，承担页面级结构识别。
- **Body** (400, 14px, 1.7): 正文内容、卡片文本和邮件详情的主阅读层级，确保连续阅读舒适。
- **Support Body** (400, 13px, 1.6): 用于状态文案、附件说明、次级提示和面板辅助信息。
- **Label** (700, 12px, 1.5): 用于卡片标题、轻量标识和需要更高识别度的小标签文本。

### Named Rules
**The Direct Label Rule.** 标签与按钮文字必须直接说动作或内容，不使用夸张语气、营销句式或“AI 感”文案。这个系统的文字目标是让用户一眼知道哪里看、哪里点、下一步做什么。

## 4. Elevation

这套系统的深度表达以纯白底和轻灰分区为主，不强调悬浮感。阴影存在，但只作为极弱的环境层级辅助；真正的层级由背景明度、边框和布局分区完成。用户应当感受到这是一个平静、稳定、没有视觉噪声的工作界面。

### Shadow Vocabulary
- **环境轻影** (`box-shadow: 0 18px 45px rgba(17, 24, 39, 0.08)`): 只用于外层 app shell，帮助整体容器从页面背景中轻微抬起。
- **内嵌选中层** (`inset 0 0 0 1px rgba(17, 24, 39, 0.04)`): 用于激活列表项时增加一点边界确定性，而不是制造卡片漂浮效果。

### Named Rules
**The Flat Reading Rule.** 正文与邮件阅读区域默认保持平面感。不要为普通内容卡片堆叠强阴影，也不要用悬浮感代替信息结构。

## 5. Components

所有组件都应当显得清晰且直接。它们的任务是表达状态和动作，而不是制造“品牌个性动作”。

### Buttons
- **Shape:** 中等圆角（12px），比系统按钮更柔和，但仍属于工具型控件
- **Primary:** 近黑底白字，`padding: 12px 20px`，作为页面主操作按钮使用
- **Hover / Focus:** hover 仅做轻微上浮和阴影增强，focus 应补足清晰可见的可访问性轮廓
- **Disabled:** 通过透明度下降表达不可操作状态，不改写整体组件形态

### Cards / Containers
- **Corner Style:** 主 panel 为 18px，大卡片为 16px，列表项为 14px，形成温和但统一的层级
- **Background:** 以纯白为主，标题区或说明区使用 `#f9fafb` 做轻微背景差异
- **Shadow Strategy:** 除最外层容器外，不依赖阴影建立层级
- **Border:** 统一使用 `#e5e7eb` 作为基础描边，需要更强状态时切到 `#d1d5db`
- **Internal Padding:** 以 12px、14px、16px 为主要内边距步进

### List Items
- **Style:** 白底、浅灰边框、14px 圆角，主题与发件人信息垂直堆叠
- **Hover:** 仅做极轻微上浮和边框加深，避免花哨反馈
- **Active:** 通过更强边框和浅灰背景表示当前选中邮件，强化“正在阅读哪一封”

### Inputs / Fields
- **Style:** 当前页面无真正表单输入，说明框与提示框可视作只读字段，使用浅灰背景和细边框表达辅助信息
- **Future Direction:** 若后续加入搜索、筛选或表单输入，应沿用白底、细描边、清晰 focus 的 GitHub-style 工具控件方向

### Navigation
- **Style:** 顶部导航与窗口条采用浅灰背景，与下方主阅读区分离
- **State:** 品牌标识与状态信息留在顶部，但不占据过多视觉权重
- **Layout:** 三栏布局中，左侧负责邮件流，中间负责阅读，右侧负责说明与流程信息，结构职责应始终稳定

### Signature Component
- **邮件附件块:** 这是页面里最有业务特征的组件。它需要同时支持“本地已下载附件”和“外链未下载附件”两种状态，外观上统一为可点击信息块，但内部可根据图片预览、虚线文件框和摘要信息灵活变化。

## 6. Do's and Don'ts

### Do:
- **Do** 优先使用 `#111827` 与白底、浅灰底的高对比组合，保证正文和关键结构始终清楚可读。
- **Do** 用 `#e5e7eb` 和 `#d1d5db` 这组轻灰边框建立结构，而不是依赖厚阴影或大色块制造层级。
- **Do** 保持三栏职责稳定，让邮件列表、阅读区、说明区各自承担明确任务。
- **Do** 让按钮、列表项、卡片都保持“清晰且直接”的企业工具感，状态变化轻但明确。
- **Do** 把附件、时间、发件人这类操作相关信息放在易扫读的位置，支持高频办公阅读场景。

### Don't:
- **Don't** 做成彩色 AI dashboard 或炫技式“智能工作台”，不要引入彩色渐变、大面积品牌色和装饰性视觉噪声。
- **Don't** 做成层级复杂、理解成本高的传统 ERP 页面，不要让用户在一个界面里被过量导航、标签和模块包围。
- **Don't** 过度营销化、装饰化，避免让这个任务工具看起来像产品展示页。
- **Don't** 用强悬浮感、厚阴影或夸张动效表达层级；这个系统更适合纯白底与轻灰分区的平静阅读感。
- **Don't** 依赖颜色作为唯一状态信号，错误、成功、选中和禁用都应当同时有文字、边框或结构上的配合提示。
