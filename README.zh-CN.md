# Job Discovery

[English](README.md)

这是 [Job Discovery Workflows](https://github.com/ChenshuXu/job-discovery-workflows) 的本地发布候选，包含全部现有功能。使用 [MIT 许可证](LICENSE)，附[第三方声明](THIRD_PARTY_NOTICES.md)。已完成一定范围的安装、宿主、账户及 Word 检查，具体结果和剩余限制见下方。

## 功能与依赖

| 功能 | 依赖 |
| --- | --- |
| Daily Scan：JobSpy、LinkedIn 搜索/推荐、Jobright；评分、去重、报告、retention、恢复与用量统计 | Career-Ops、候选人资料、代理宿主与各来源工具 |
| 展开 compact report | Career-Ops |
| 单项/批次申请与私有答案管理 | Career-Ops、Ego Lite、面试登记表 |
| 报告绑定 Word 简历 | Career-Ops、自己的兼容 DOCX 模板、zip/unzip；macOS Word 实测页数 |
| Gmail 审查与面试登记事务 | Career-Ops、Career Docs；主账号连接 Gmail app，次账号通过宿主原生工具访问 Chrome |
| 面试研究、证据账与增量更新 | Career Docs、Ego Lite、外部研究访问、obsidian-markdown |
| 申请与面试流程统计图 | Career-Ops、Career Docs、Node.js、Python 3 和 Pillow、覆盖图中文字的字体 |
| 招聘帖扫描与 outreach 准备 | Career-Ops、Ego Lite、Node SQLite；停在 Send 前 |
| 独立 Google ATS 搜索 | SerpAPI key；不属于 Daily Scan |
| 报告与排除岗位修复 | Career-Ops、已完成 run、显式审核清单和计划 hash |

## 让 Agent 帮你完成设置

把这份 README 交给 Agent，并发送：

```text
请按这份 README 设置 Job Discovery。先检查我已有的工作区，询问缺少的 CV、搜索条件和账户信息，安装缺失的依赖，只创建缺失的设置文件，保留已有数据。运行 setup-check 和文档要求的检查，最后逐项告诉我哪些流程已就绪，以及我还需要提供什么、修改哪里。设置期间不要开始扫描、retention 清理、调度、申请或发送消息。
```

### Agent 执行步骤

1. **先定位再修改。** 找到 Job Discovery、Career-Ops、JobSpy 和 Career Docs，优先同级布局，但复用用户已有安装与登记表。读取各工作区已有的 AGENTS.md。从 Job Discovery 运行 `node src/setup-check.mjs --json`，按 `checks` 和 `action` 建立缺项清单。退出码 1 表示设置缺失或无效，不能据此删除旧文件。这些自定义路径可用 `--career-ops PATH`、`--career-docs PATH`、`--jobspy PATH` 传给 setup-check。简历命令须在同一 shell 中设置 `export CAREER_OPS_ROOT=/绝对路径/career-ops`；setup-check 也读取此值，显式 `--career-ops` 优先。其他流程使用各自已有的参数或配置路径，setup-check 参数不会自动修改它们。
2. **集中询问缺少的信息。** 收集用户的 CV 或本地路径、要启用的流程/来源、目标岗位关键词与级别、城市/远程范围、雇佣类型、雇主排除项、时区、匹配所需的工作许可/赞助事实，以及已有面试登记表。只有选用相关流程时才询问 Gmail 账户和浏览器 profile。创建空登记表前确认是否已有活跃面试；缺文件不代表没有面试。复用本轮已提供的答案，等待时继续独立设置；不索取密码、cookie 或一次性验证码。
3. **安装缺失工具。** 按下文安装依赖，JobSpy 使用 main。仅在缺少时安装 Career-Ops、Ego Lite，使 8 个内置 Skill 可用并加载所需外部 Skill。设置授权不意味着升级、重置或替换已有安装。登录/验证由用户通过正常浏览器流程完成，凭证不写入报告或 Git。
4. **设置 Career-Ops。** 在其仓库读取自己的 Skill 和安装说明，使用 `interview` 模式进行资料/CV onboarding。依据真实 CV 和已确认回答，一致地创建或更新 `cv.md`、`config/profile.yml`、`modes/_profile.md`，保留其他字段和文档。不虚构职位、时间、经历、指标或工作许可。运行 `node doctor.mjs --json --cli codex`（换成实际 CLI），即使退出码为 0 也读取 `missing` 和 `unpersonalized`。Doctor 可能补缺失模板；新上游的 `modes/_brief.md` 也须依据同一 CV 和已确认选择个性化，自动复制模板不代表 onboarding 完成。简历解析器需要 `## PROFESSIONAL EXPERIENCE`、`### 职位, 公司 | 地点` 和 `-` 条目，以及 `## TECHNICAL SKILLS` 下的 `**类别:** 技能, 技能`；适配格式不能改动事实。缺 CV 或事实不明确时记录具体阻碍。
5. **配置搜索和 Career Docs。** 按下表和目录结构操作。只给缺失配置复制 example；已有文件先读取，再合并用户明确选择，不能用示例覆盖。搜索参数与 profile 地点政策要一致。只创建 Career Docs 缺失的骨架文件；已有面试登记通过 Gmail Skill 的 canonical writer 修改。
6. **检查并修复。** 运行下文检查，修复常规设置错误后重跑受影响项。只对缺少的事实、账户或重要选择询问用户。不能为了检查通过而悄悄改变目标地区或关闭用户要求的功能；不支持的能力按流程标为阻碍。
7. **逐流程交付。** 使用“可开始首次运行 / 需用户补充 / 暂不支持 / 验证失败”，列出具体文件/配置项、下一动作和实际检查结果。同时列出创建/修改的文件及未解问题。文件存在不等于就绪。设置到此结束，真实运行由用户另外发起。

### Career-Ops 与搜索条件映射

| 用户信息 | Agent 应配置的位置 |
| --- | --- |
| CV、经历、教育、技能与匹配事实 | Career-Ops onboarding → `cv.md`、`config/profile.yml`、`modes/_profile.md`，三份保持一致 |
| 本地城市 / 美国远程资格 | Career-Ops `config/profile.yml` → `location.scan_policy`，格式见下方 |
| 搜索关键词与搜索地点 | Job Discovery `config/jobspy-ego.json` → `queries`、`location`；搜索参数不覆盖资格政策 |
| 启用来源 | `config/discovery-adapters.v1.json` 中各 `enabled` 与 `minimum_successful_adapters` |
| 雇主排除 | 各来源配置的 `employer_exclusions`；只写用户选择，无排除时为 `[]`，保留各 adapter 的规则 schema |
| Jobright 岗位、地点、级别、工作模式、经验范围 | 用户接受的浏览器筛选 → `config/jobright.json` 的 `filter_snapshot` values/codes/visible_controls，必须实际采集，不能编造 |
| 独立 Google ATS 搜索 | `config/google-ats-direct.json` 的 role/location/negative terms 与 official_scope，编辑后运行对应校验 |
| 招聘帖搜索 | `linkedin-post-scan/config/post-scan.json` 的 role/location/phrase groups 和 paths |
| worker 模型、并发、报告阈值、retention TTL | `config/daily-scan-runtime.json`；选择宿主可用模型，实跑前解释 retention 行为 |
| 邮箱身份、登录与时区 | 私有 `.local/gmail-job-reply-review/accounts.json` 的 `primary`、`secondary` 邮箱地址字符串；主账号使用已连接的 Gmail app，次账号通过宿主原生浏览器工具访问已登录的 Chrome。Gmail Skill 当前登记主日期使用 America/Los_Angeles |

`location.scan_policy` 当前要求**缩进两空格的单行 JSON**。将[示例片段](examples/location-scan-policy.fragment.yml)合并到已有 `location`，不能覆盖整个 profile：

```yaml
location:
  scan_policy: {"local_metros":["Seattle","Bellevue"],"remote_country":"United States","require_structured_remote":true,"ambiguous_action":"exclude"}
```

评分政策当前支持 Mid-level 至 Senior 的永久全职岗位，并固定限制 Staff-equivalent 的分数。其他级别或雇佣类型需要修改政策与代码，不能仅修改 profile 文本就宣称支持。

这些城市仅作示例，须由用户确认。当前本地匹配包含华盛顿州假设，城市列表必须非空，远程只支持美国。其他国家、非华盛顿州本地市场或 remote-only 空城市列表，不能只改 JSON 就宣称支持。应说明限制，不能静默保留示例城市或报告设置成功。

### Career Docs 目录结构

Career Docs 是用户的私有文档工作区，不是另一个要下载的软件包：

```text
career-docs/
  .git/                                  面试登记事务所需的本地私有历史
  AGENTS.md                              归属与编辑规则
  context/
    00 Knowledge Base Hub.md             已有候选人/面试资料索引
    .obsidian/                           可选，打开 context 为 vault 时创建
    Interview/
      active-interviews.md               唯一流程登记表和面试 TODO
      <company>/                         只为真实且已确认身份的面试创建
        process-summary.md              身份与有日期的沟通记录，由 Notes 链接
        <company>-<role>-interview-prep-<date>.md
        <company>-<role>-interview-evidence-<date>.md
        research-<date>/                 需要时保存研究证据
```

[工作区规则模板](examples/career-docs/AGENTS.md)、[索引模板](examples/career-docs/context/00%20Knowledge%20Base%20Hub.md)和[空登记表](examples/career-docs/context/Interview/active-interviews.md)仅用于缺失文件，不创建虚构公司、轮次或 TODO。用户在别处已有登记表时，先解析归属与路径，不另建副本。对于全新工作区，初始化本地 Git，仅提交新骨架使 writer 有初始 HEAD；不配置公开 remote，不暂存无关文件。已有私有仓库和历史保持不变。面试 TODO 保存在 `active-interviews.md`，不需要第二份流程表。创建文件无需 Obsidian；使用 Obsidian 时 vault 根目录为 `career-docs/context/`。

### 检查与完成标准

`node src/setup-check.mjs --json` 只读输出路径、缺项和动作，不输出 CV 正文，也不证明事实已获确认。`scope` 标明缺项影响哪个流程。它检查基本文件、CV/登记结构、地点/runtime 配置及部分来源字段，不覆盖所有 adapter 约束或登录状态。即使退出码为 0，仍需人工/Agent 检查，不能直接当成生产就绪。

配置完成后，Agent 还必须：

- 在 Career-Ops 根目录运行其健康与 CV 一致性检查，核验写入接口。Doctor 可能初始化缺失文件，只能在获准的 setup 中运行。
- 检查 JobSpy runtime/import、Ego Lite 和外部 Skills；由用户完成登录，确认实际账户，不打印秘密。
- 对选用来源运行配置校验/dry-run 并查看结果。`npm run daily-scan:sources -- --run runs/installation-preview --dry-run` 只预览命令，不证明来源可用。
- 使用简历功能时核验模板与 CV 对应，并查看渲染页。按[本人模板准备流程](assets/README.md)运行 `npm run resume:template`，保留用户资料或视觉验收尚未完成的具体缺项。
- 在交付中保留候选版已知测试失败与限制。Setup 文档不能消除实现缺陷，不把真实扫描、retention、调度或申请当成安装测试。

## 本项目包含的 Skills

本仓库包含 **8 个 Skill**，位于 `.agents/skills/<名称>/`。下表链接可直接查看各自的实际指令。克隆后这些文件已在本地，但不代表代理已经加载它们或完成全局安装。

| Skill 名称 | 用途 |
| --- | --- |
| [career-ops-daily-linkedin-scan](.agents/skills/career-ops-daily-linkedin-scan/SKILL.md) | 运行或核验已配置岗位来源，评分并保存报告；支持恢复、用量比较与调度，不提交申请。 |
| [career-ops-expand-report](.agents/skills/career-ops-expand-report/SKILL.md) | 将一个选定的 compact report 展开为完整 Career-Ops 报告。 |
| [career-ops-tailored-resume](.agents/skills/career-ops-tailored-resume/SKILL.md) | 为一个已有报告生成真实的一页 Word 简历，检查事实、JD 覆盖和页数。 |
| [career-ops-ego-apply](.agents/skills/career-ops-ego-apply/SKILL.md) | 准备并提交选定申请或冻结批次，从批准的事实来源解析答案并核验结果；此 Skill 会提交申请。 |
| [gmail-job-reply-review](.agents/skills/gmail-job-reply-review/SKILL.md) | 审查求职 Gmail 回复或直接更新流程，协同维护唯一面试登记表、TODO 和链接的公司 process summary。 |
| [linkedin-post-scan](.agents/skills/linkedin-post-scan/SKILL.md) | 发现招聘帖，将准确岗位交给 Career-Ops，并准备 outreach；停在 Send 前。 |
| [technical-interview-prepare](.agents/skills/technical-interview-prepare/SKILL.md) | 调研已约面试轮次和近期题目，维护准备文档及独立证据账。 |
| [process-infographic](.agents/skills/process-infographic/SKILL.md) | 从 Career-Ops 读取申请数量，从 Career Docs 读取面试流程，动态统计并渲染流程图；支持自定义路径和格式适配。 |

在代理中打开本仓库后，查看可用 Skill 列表，核对上面 8 个名称。缺少时使用宿主的 Skill 加载机制；也可以明确要求代理读取上表链接的 `SKILL.md` 执行任务。支持 `$skill-name` 的宿主可这样调用：

```text
使用 $career-ops-tailored-resume，为我选定的 Career-Ops 报告制作简历。
```

多个 checkout 提供同名 Skill 时，向代理提供目标 checkout 中 `.agents/skills/<name>/SKILL.md` 的绝对路径，并核对实际加载的路径。名称相同不能证明选中了正确 checkout。宿主同名选择与桌面重载/缓存须分别检查，setup 不会自动去重。

其余 Skill同样按名称调用，并提供各自要求的准确报告、申请范围或面试目标。加载 Skill 不会自动启动工作流。独立 Google ATS 和修复命令是 CLI 工具，不是另外的 Skill。

申请和面试的数据归属、默认 Career Docs 结构、`--career-docs` / `--interviews-file` 及非标准登记格式的适配见[来源说明](.agents/skills/process-infographic/references/interview-records.md)。按[渲染设置](.agents/skills/process-infographic/references/rendering.md)准备 Python 3、Pillow 和覆盖图中文字的字体，中文图需含中文字形。整个输出目录都应保密：即使只渲染无名称版，目录内仍保留私有 JSON 快照。对外只交付审阅过的 PNG/SVG。

### 需要另行安装的外部 Skills

| Skill | 来源与用途 |
| --- | --- |
| `ego-browser` | 由 [Ego Lite](https://github.com/citrolabs/ego-lite) 提供，让代理操作浏览器；浏览器流程需要它。 |
| `career-ops` | 由 [Career-Ops](https://github.com/career-ops-hq/career-ops) 提供，用于其自身的求职管理和 onboarding；与本项目 8 个 Skill 不同。 |
| `obsidian-markdown` | 通过宿主 Skill 列表另行安装；面试准备 Skill 使用其 Obsidian Markdown 语法规范。 |

这些外部 Skill 不随本仓库复制。安装 Skill 也不能代替安装对应应用，或准备所需账户与资料。

## 外部依赖是什么

**[Career-Ops](https://github.com/career-ops-hq/career-ops)** 是开源求职管理系统，负责候选人资料、岗位评估、报告和申请状态。Job Discovery 在其基础上增加岗位采集与工作流自动化，并通过 Career-Ops 已有的数据和写入接口保存结果。将仓库安装到同级的 `../career-ops/`，按[安装与 onboarding 指南](https://github.com/career-ops-hq/career-ops/blob/main/docs/SETUP.md)准备自己的资料；它不会随 Job Discovery 自动安装。

**[Ego Lite](https://github.com/citrolabs/ego-lite)** 是供用户与 AI 代理共同使用的 Chromium 浏览器。Job Discovery 通过它读取已登录的 LinkedIn、Jobright 页面，采集面试资料，以及操作申请表单。**`ego-browser` 是控制 Ego Lite 浏览器的命令和代理 Skill 名称。**先按[官方安装指南](https://github.com/citrolabs/ego-lite/blob/main/skills/ego-browser/references/install.md)安装浏览器应用，再让代理加载其 Skill，并登录需要访问的网站。它按浏览器应用安装，不需要像 Career-Ops 一样克隆到同级目录。下载入口见 [Ego Lite 官网](https://lite.ego.app/)；当前浏览器应用面向 macOS。

**[JobSpy](https://github.com/speedyapply/JobSpy)** 是 Python 岗位采集库，供 JobSpy 来源使用，运行在 `../JobSpy/.venv/` 中，不依赖 Ego Lite。用户可按需要安装、启用来源；项目仍保留全部功能。

## 安装

在任意工作区保持同级布局：

```text
workspace/
  job-discovery/       本候选目录，可将 job-discovery-public 改名
  career-ops/          代码和个人资料/数据
  JobSpy/.venv/        独立 Python 环境
  career-docs/           私有面试工作区
```

从本仓库根目录安装缺少的依赖，不覆盖已有目录：

```bash
git clone https://github.com/career-ops-hq/career-ops.git ../career-ops
(cd ../career-ops && npm install)
git clone --branch main https://github.com/speedyapply/JobSpy.git ../JobSpy
python3.12 -m venv ../JobSpy/.venv
../JobSpy/.venv/bin/python -m pip install --upgrade "pip>=21.3"
../JobSpy/.venv/bin/python -m pip install -e ../JobSpy
```

Career-Ops 与 Ego Lite 是单独安装的开源依赖。通过 Career-Ops onboarding 准备自己的 `cv.md`、`config/profile.yml`、`modes/_profile.md`。安装 Ego Lite，使 `ego-browser` 位于 PATH，并在代理中加载其 Skill；浏览器/Gmail 使用自己的登录账户。这些工具、凭证和私人数据不随包分发。JobSpy 要求 Python >=3.10,<4，不支持 macOS 系统 Python 3.9。setup 默认使用 `python3`，可用 `--python /path/to/python3.12` 指定兼容解释器。离线测试使用 Node 26.0.0/macOS，其他版本/平台未验收。

本项目 Skills 位于 `.agents/skills/`。在代理中打开本仓库，通过宿主机制发现/安装；外部 Skill 从宿主列表定位。下文命令均相对于本仓库根目录。

## 配置

来源配置将需要的 `.example.json` 复制为去掉 `.example` 的文件名，仅在目标不存在时复制。检查所有设置，实际配置已被忽略。示例不含维护者的雇主排除或账户数据。

```bash
cp -n config/discovery-adapters.v1.example.json config/discovery-adapters.v1.json
cp -n config/daily-scan-runtime.example.json config/daily-scan-runtime.json
cp -n config/jobspy-ego.example.json config/jobspy-ego.json
```

Gmail 使用 `npm run setup -- --workflows gmail --apply`，从空白 `config/gmail-accounts.example.json` 创建缺失的 `.local/gmail-job-reply-review/accounts.json`，已有设置会保留。将 `primary`、`secondary` 填为用户确认的账号地址；读信前还须确认已连接 Gmail app 的主账号身份，以及 Chrome 中次账号的实时 Google Account。缺少某个账号只阻塞该邮箱。地址保存在被忽略的本地文件；登录、密码和验证码留在正常认证流程中处理。

示例 registry 只启用 JobSpy。LinkedIn/Jobright 需先配置 Ego Lite 与登录；Jobright 的空 filter snapshot 必须替换为自己实际接受的筛选状态，不能直接授权扫描。已禁用来源不再要求本地配置文件。Google ATS 和 Post Scan 各有示例配置；Google 的空 `title_exclusions` 表示不排除职位标题，地点规则仍须通过校验。worker 模型须在宿主可用；实跑前审阅 retention TTL，扫描会清理符合条件的旧 Evaluated 记录，并保护申请/面试/人工活动。

[虚构示例](examples/README.md)提供 CV 内容及空面试登记表，只能用于新工作区，不能覆盖已有登记表。示例不能作为申请答案。实际资料保存在 Career-Ops/Career Docs 与 `.local/`。简历构建需要自己的 `assets/cv-template.docx`。按[本人模板准备流程](assets/README.md)创建和核验，运行 `npm run resume:template`，再检查渲染页。缺失模板会明确报告，不能用空 DOCX 占位。编写简历计划前运行 `mkdir -p .tmp`。

独立 Google ATS 的初始化步骤如下，不覆盖已有文件：

```bash
cp -n config/google-ats-direct.example.json config/google-ats-direct.json
cp -n .env.example .env
npm run google-ats:scan -- --dry-run
```

真实扫描前，将 `SERPAPI_API_KEY` 写入被忽略的 `.env` 或进程环境；不能写入公开的 `.env.example`。缺少 `.env` 不影响启动或 dry-run，但真实扫描仍会检查凭证。Dry-run 不发起付费请求。

`runs/`、`.local/`、Post Scan 数据与报告目录由运行时创建。`assets/README.md` 保留输入目录；手工编写简历计划前创建 `.tmp/`。公开版无需 `docs/`、`audits/`、`drafts/`。

## 检查与首次运行

```bash
python3 adapters/jobspy_linkedin_scan.py --runtime-check
../JobSpy/.venv/bin/python -c "from jobspy import scrape_jobs; assert callable(scrape_jobs)"
node --input-type=module -e "import { loadCareerInterfaces } from './src/commit-scan.mjs'; await loadCareerInterfaces('../career-ops'); console.log('interfaces OK')"
npm run daily-scan:sources -- --run runs/installation-preview --dry-run
npm test
```

环境、导入、接口与 dry-run 检查不证明在线采集覆盖或端到端兼容。`npm test` 使用临时的虚构样例，不依赖私人 Career-Ops checkout。生产运行需要 Career-Ops、自己的资料和来源配置。Career-Ops `doctor.mjs` 可能创建缺失文件。

首次真实扫描在代理中调用 `$career-ops-daily-linkedin-scan`，要求按自己的配置运行已启用来源。Skill 负责阶段顺序和核验，成功后返回报告和 `runs/<run-id>/receipt.json`。扫描执行 retention 并写入评估，但不提交申请。申请需单独调用 `$career-ops-ego-apply` 并明确范围；其他流程使用对应 Skill。

修复工具现在要求 `--manifest FILE`。先 dry-run，再应用：报告修复使用 `--plan-sha256 HASH`，排除岗位修复使用 `--expected-plan-hash HASH`。原始 run 不变。`examples/` 中的清单只用于说明结构，应换为审核过的准确 run/岗位身份，不能按标题猜测。

## 发布验证与限制

全部实现都已包含；这是可供审阅的候选版，尚未完成发布。截至 2026-09-26，已在 macOS 通过：

- 公开候选测试 **315/315**，开发仓库测试 **319/319**。
- 全新 Career-Ops 安装成功，含 Chromium；使用虚构 CV/profile 的 onboarding、完整 doctor、profile/CV 一致性、pipeline、writer interface、统计/采集器及 canonical register 检查通过，空输入计数为零。上游仍提示无法自动检测 Codex Playwright MCP，以及默认 Vinted portal 无 provider；这些检查不代表 Job Discovery 来源就绪。
- Codex CLI 实际读取八个内置 Skill，在候选本地及独立 Career Docs 的 Skill 链接中均解析到公开 checkout；用显式 Skill 路径区分其他 checkout 的同名 Skill。
- Gmail 主账号连接器、次账号 Chrome 的身份匹配与只读搜索通过；LinkedIn、Jobright 登录读取通过。公开 JobSpy adapter 使用当前包真实采集到一个含 JD 的岗位，错误数为零。
- Microsoft Word **16.73** 将测试 DOCX 渲染为 **一页**，视觉审阅通过。

这些结果只覆盖已测环境、账号和模板。虚构 onboarding 资料不等于用户确认的事实，评分示例也不是生产校准；其他系统、模板和账号仍需各自检查。尚未验证完整的账户工作流事务、GUI Skill 选择、同名自动选择或桌面缓存重载。验收没有进行真实投递、发信或生产 retention；单个岗位采集不证明来源覆盖。

私人 golden tests、原始 JD 采集样例、日志、报告、历史修复清单、凭证、浏览器状态、私人模板和开发文档不分发。MIT 与第三方声明已包含。


## 可重复的本地 setup 与更新

```bash
npm run setup
npm run setup -- --workflows daily-scan --sources jobspy
npm run setup -- --workflows daily-scan --sources jobspy --apply
# 自动安装所选缺失依赖：追加 --install --python /path/to/python3.12
# 跨项目使用：追加 --links /实际宿主/skills/绝对路径
```

支持 `daily-scan,expand,resume,apply,gmail,interview,post-scan,google-ats,process-infographic`。
无参数显示选择；默认预览，`--apply` 只初始化缺项，已有值和链接保留，冲突停止。
`--install` 可 clone 缺失 Career-Ops、JobSpy main 并准备/验证 JobSpy venv；
`CAREER_OPS_ROOT` 同时指定 Career-Ops 安装位置。新 clone 的 Career-Ops 还需在其目录
运行 `npm install`，再按上文完成 onboarding、Ego/宿主连接、Career Docs 唯一登记表与真实模板。
安装程序不会把示例或文件存在当成已确认事实；每个所选功能列出缺项和下一步。
当前只验收 Node 26.0.0/macOS；其他版本/平台尚未完成兼容验收。

从 Career Docs 调用时，先对宿主 Skill 的实际链接执行 `realpath`，从解析后文件
所在的 `.agents/skills/<name>/` 目录向上三级确定 checkout；可用该 checkout 的
`node src/setup.mjs --skill-root /绝对/Skill/SKILL.md` 核对。随后 `cd` 到返回的根目录。
Ego Apply 的 `--memory` 使用该根目录下 `.local/career-ops-ego-apply/application-memory.json`
的绝对路径，不能从当前 Career Docs cwd 创建第二份答案库。Codex CLI 已实际读取八个 Skill，
包括跨项目链接，并解析到目标公开 checkout。同名时使用显式路径；GUI 选择、同名自动解析和
桌面缓存重载仍未验证。

更新前等工作流与写事务结束、保留本地源码改动并检查发布说明，然后：

```bash
git pull --ff-only
npm run setup -- --workflows google-ats
```

示例配置随代码更新；实际配置、模板、私人状态和 Career Docs 内容不被覆盖。
用相同功能/source 参数复查，缺失配置可显式 `--apply` 补齐；已有配置的新必填字段由 owning
validator 报告，按发布说明补字段。不要覆盖整个文件。升级前自行备份必要私人数据；
Git 回退不能恢复数据库迁移。`setup-check` 是全量 inventory，可能报告未选择来源的缺项；
`setup` 才按选择筛选结果。

离线验收：`npm test` 在临时 checkout 中建立固定测试配置与独立 Git 历史，
不使用实际运行配置或相邻私人仓库。测试套件本身不证明账号、实时采集、Word 页面或申请成功；
另行实测的结果及其范围见上方。
