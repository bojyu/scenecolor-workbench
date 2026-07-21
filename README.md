# SceneColor

本地场景图产品换色工具，支持手动上传和文件夹批量处理。

## 开发运行

Windows 可以直接双击项目根目录的 `一键启动工作台.cmd`。脚本会检查 Node.js 和依赖，启动前端与后端，并在页面就绪后自动打开浏览器；保持启动窗口开启即可，按 `Ctrl+C` 停止服务。

```bash
npm ci
npm run dev
```

浏览器访问 `http://localhost:5173`。本地服务仅监听 `127.0.0.1:3001`。

## 构建运行

```bash
npm run build
npm start
```

浏览器访问 `http://localhost:3001`。

## 批量目录结构

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

生成结果保存在项目目录下的 `套版输出/`。只有无法解析接口响应时，调试 JSON 才会写入 `套版输出/raw_json/`。

生成前可以选择图像比例。`auto` 为默认值，会让接口按照图1场景原图比例生成；也可以固定为模型支持的常用横版、竖版、方形或超宽/超长比例。

## 场景角度自动识别

应用顶部提供独立的后台模型配置面板，显示 Codex 是否安装、是否登录及实际运行版本。它直接启动隐藏的非交互后台任务，不要求 Codex 窗口保持打开。可以选择：

- `config.toml` 中当前登录的 Codex或已经配置的自定义模型供应商
- GPT-5.6 Sol、GPT-5.6 Terra 等匹配模型
- 低、中、高、超高、最大和 Ultra 思考强度（以模型与账户实际支持范围为准）
- 应用 `skills/` 目录中可用的训练 Skill

“套版工作台”“Skill 训练”和“单图换色”是三个独立页面；模型配置由前两个页面共享。“Skill 训练”只运行数据校准、结构化识别、规则匹配和回归验证，不启动图片生成。

在套版工作台填写项目路径并点击“角度识别”。工作台会通过选择的 Codex 后台批量查看场景图，并把所选 Skill 的训练规则、项目本地产品锚点和安全拒绝门禁一并用于识别与匹配。这个入口不使用页面中的 Comfly API Key，也不会调用图片生成接口或自动重试模型。

识别结果包括：

- 8 个标准角度或多椅子/无法判断
- 0-359.9° 方位角
- 俯仰角、镜像、遮挡率和椅子数量
- 置信度与判断理由

Codex + Skill 结果写入输入项目的 `.scenecolor/skill-training/scene-angle-results.json` 和 `footrest-matching-results.json`，每次点击发起一次批量 Codex 调用，单次最多处理 24 张场景。项目需要提供 `.scenecolor/skill-training/product-angle-index.json`；缺失时会尝试使用应用内置的 J97A 索引。

如需固定角度识别模型，可设置：

```env
CODEX_ANGLE_MODEL=
SCENECOLOR_CODEX_BIN=
```

`CODEX_ANGLE_MODEL` 留空时沿用当前 Codex 配置；只有 Codex 不在系统默认安装位置时才需要设置 `SCENECOLOR_CODEX_BIN`。

原有“识别工具”菜单仍保留兼容视觉聊天接口：其结果按图片哈希保存在 `.scenecolor/scene-angles.json`，相同图片会使用缓存。

## 图2角度识别与自动匹配

场景角度识别完成后，点击“识别图2并匹配”。工作台会：

1. 对尚未处理的图2素材各识别一次角度，并写入 `.scenecolor/product-angles.json`。
2. 在每个产品/颜色素材组内选择与场景角度最接近的图2。
3. 将推荐关系写入 `.scenecolor/angle-matches.json` 并自动预选。
4. 对中等置信度结果显示“待确认”；低置信度结果不进入生成队列。

匹配和预选不会调用图片生成接口。用户仍需在工作台确认并点击“批量生成”。Agent 通过 MCP 完成识别后，重新扫描项目即可加载同一批匹配记录。

角度识别使用与现有接口兼容的视觉聊天模型，可通过环境变量覆盖：

```env
ANGLE_API_URL=https://ai.comfly.org/v1/chat/completions
ANGLE_MODEL=gemini-3-flash-preview
```

## MCP Agent 接口

启动独立的场景角度 MCP Server：

```bash
npm run mcp
```

可使用 MCP Inspector 验证：

```bash
npx @modelcontextprotocol/inspector npm run mcp
```

提供以下工具：

- `open_angle_project`
- `list_scene_angle_tasks`
- `get_scene_angle_image`
- `save_scene_angle_analysis`
- `list_scene_angle_results`
- `list_product_angle_tasks`
- `get_product_reference_image`
- `save_product_angle_analysis`
- `match_scene_product_angles`
- `list_angle_matches`

MCP Server 只允许 Agent 读取项目场景图/图2参考、保存角度分析和匹配推荐，不提供图片生成工具，也不会调用付费生成 API。Agent 应分别查询场景和图2的待处理任务，每张图读取并保存一次，最后调用匹配工具。

## 验证

```bash
npm run check
```

该命令依次执行 TypeScript 检查、自动测试和生产构建。
