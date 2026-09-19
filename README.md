# SceneColor

本地运行的场景图产品换色工具。丢一批场景图和产品图进去，自动配色、自动核验、自动修细节，减少人工套版的重复劳动。

## 快速开始

Windows 双击根目录的 `一键启动工作台.cmd` 即可：脚本会检查 Node.js、装好依赖、拉起前后端，页面就绪后自动打开浏览器。保持窗口开着，`Ctrl+C` 停止。

其他平台或想自己控制流程：

```bash
npm ci
npm run dev
```

打开 `http://localhost:5173`，后端只监听 `127.0.0.1:3001`，不对外暴露。

生产模式：

```bash
npm run build
npm start
```

访问 `http://localhost:3001`。

## 工作流程

四个页面，从左到右是一条流水线，「Skill 训练」独立于外：

| 页面 | 做什么 |
| --- | --- |
| 套版工作台 | 手动上传或按目录批量处理，场景角度识别 + 图2匹配 + 批量生成换色结果 |
| 生成核验 | 人工确认后的结果会送到这里，`chair-result-verifier` Skill 对比生成图、原场景、产品参考，判断是否需要重新生成或修细节 |
| 细节重绘 | 核验后发现局部问题（Logo、缝线、包边、纹理、五金）的图，交给 `chair-detail-restorer` 定位、裁切、局部重绘、回贴 |
| Skill 训练 | 独立跑数据校准、结构化识别、规则匹配和回归验证，不产生图片、不调用生成接口 |

批量模式的目录约定：

```text
项目目录/
  scenes/
    001.jpg
    002.jpg
  products/
    白色/
      chair.jpg
    黑色/
      chair.jpg
```

生成结果落在项目目录的 `套版输出/`；只有接口响应解析失败时才会往 `套版输出/raw_json/` 写调试 JSON。生成前可以选图像比例，默认 `auto` 跟随场景原图，也能固定成模型支持的横版/竖版/方形/超宽等常用比例。

## 场景角度自动识别

顶部有独立的后台模型配置面板，能看到 Codex 是否装好、是否登录、实际跑的版本。任务是隐藏的非交互后台任务，不需要一直开着 Codex 窗口。可选：

- `config.toml` 里当前登录的 Codex，或自己配置的模型供应商
- GPT-5.6 Sol、GPT-5.6 Terra 等匹配模型
- 低/中/高/超高/最大/Ultra 六档思考强度（以模型和账户实际支持为准）
- `skills/` 目录下已训练好的 Skill

在套版工作台填好项目路径、点「角度识别」，工作台会用选中的 Codex 后台批量读场景图，结合所选 Skill 的训练规则、项目本地产品锚点和安全拒绝门禁做识别和匹配。这一步不用页面上的 Comfly API Key，也不碰生成接口，不会自动重试。

识别结果包含：8 个标准角度（或多椅子/无法判断）、0–359.9° 方位角、俯仰角、镜像、遮挡率、椅子数量，以及置信度和判断理由。

结果写入项目的 `.scenecolor/skill-training/scene-angle-results.json` 和 `footrest-matching-results.json`，每次点击发起一批 Codex 调用，单批最多 24 张场景图。需要项目提供 `.scenecolor/skill-training/product-angle-index.json`，缺失时会退回用内置的 J97A 索引。

固定识别模型可以设置环境变量：

```env
CODEX_ANGLE_MODEL=
SCENECOLOR_CODEX_BIN=
```

`CODEX_ANGLE_MODEL` 留空则跟随当前 Codex 配置；`SCENECOLOR_CODEX_BIN` 只有 Codex 不在系统默认安装路径时才需要填。

旧版「识别工具」菜单还保留着，走兼容的视觉聊天接口，结果按图片哈希缓存在 `.scenecolor/scene-angles.json`，同一张图不会重复识别。

## 图2角度识别与自动匹配

场景角度识别完成后点「识别图2并匹配」，工作台会：

1. 给还没处理过的图2素材逐个识别角度，写入 `.scenecolor/product-angles.json`
2. 在每个产品/颜色素材组里，挑角度最接近当前场景的图2
3. 把推荐关系写入 `.scenecolor/angle-matches.json` 并自动预选
4. 中等置信度的结果标「待确认」，低置信度的不进生成队列

这一步不会调用生成接口，用户还是要在工作台确认后手动点「批量生成」。Agent 走 MCP 完成识别后，重新扫描项目就能读到同一批匹配记录。

角度识别用的视觉模型可以用环境变量换掉：

```env
ANGLE_API_URL=https://ai.comfly.org/v1/chat/completions
ANGLE_MODEL=gemini-3-flash-preview
```

## MCP Agent 接口

单独起一个场景角度 MCP Server：

```bash
npm run mcp
```

想验证的话用 MCP Inspector：

```bash
npx @modelcontextprotocol/inspector npm run mcp
```

提供的工具：

`open_angle_project` · `list_scene_angle_tasks` · `get_scene_angle_image` · `save_scene_angle_analysis` · `list_scene_angle_results` · `list_product_angle_tasks` · `get_product_reference_image` · `save_product_angle_analysis` · `match_scene_product_angles` · `list_angle_matches`

MCP Server 只让 Agent 读场景图/图2参考、保存角度分析和匹配推荐，不提供生成图片的工具，也不会调用付费接口。Agent 应该分别查场景和图2的待处理任务，每张图读一次存一次，最后调匹配工具收尾。

## 验证

```bash
npm run check
```

依次跑 TypeScript 检查、单元测试、生产构建。
