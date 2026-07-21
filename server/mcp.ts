#!/usr/bin/env node
import { readFile } from 'fs/promises'
import { basename } from 'path'
import sharp from 'sharp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod/v4'
import { scanProject } from './lib/projectScanner.js'
import {
  getSceneAngleAnalysis,
  getSceneAngleAnalyses,
  saveSceneAngleAnalysis,
  SCENE_ANGLES,
} from './lib/sceneAngles.js'
import {
  getProductAngleAnalysis,
  getProductAngleAnalyses,
  saveProductAngleAnalysis,
} from './lib/productAngles.js'
import { calculateAndSaveAngleMatches, listStoredAngleMatches } from './lib/angleMatches.js'

const angleSchema = z.enum(SCENE_ANGLES)

const server = new McpServer(
  { name: 'scenecolor-angle-agent', version: '1.1.0' },
  {
    instructions:
      'This server supports chair angle analysis and safe scene-to-product-reference matching. Analyze each pending scene and product reference exactly once, save one structured result, then call match_scene_product_angles. Treat front as strict: use it only within 10 degrees of 0 and when the chair is nearly bilaterally symmetric; visible armrest, seat-edge, side-panel, or backrest perspective means front_right/front_left with a non-zero azimuth. Determine direction from the projected chair-front/seat axis in the final image: use front_right/right when it points toward image-right and front_left/left when it points toward image-left. Never infer direction from the screen position of the nearer armrest alone. Do not invent file paths. Never call generation APIs. Skip images that already have a high-confidence analysis unless the user explicitly requests review.',
  },
)

async function requireProjectScene(projectPath: string, scenePath: string) {
  const project = await scanProject(projectPath)
  if (!project.scenes.includes(scenePath)) throw new Error('该场景图不属于指定项目')
  return { project, scenePath }
}

async function requireProjectProduct(projectPath: string, productPath: string) {
  const project = await scanProject(projectPath)
  if (!project.products.includes(productPath)) throw new Error('该图2素材不属于指定项目')
  return { project, productPath }
}

server.registerTool('open_angle_project', {
  title: 'Open SceneColor angle project',
  description: 'Open a SceneColor project folder and summarize scene-angle analysis progress. This does not call any paid model API.',
  inputSchema: {
    projectPath: z.string().min(1).describe('Absolute project path containing scenes/ and products/'),
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
}, async ({ projectPath }) => {
  const project = await scanProject(projectPath)
  const [analyses, productAnalyses, matches] = await Promise.all([
    getSceneAngleAnalyses(project.scenes),
    getProductAngleAnalyses(project.products),
    listStoredAngleMatches(project.root),
  ])
  const structuredContent = {
    projectPath: project.root,
    sceneCount: project.scenes.length,
    analyzedCount: analyses.length,
    pendingCount: project.scenes.length - analyses.length,
    productCount: project.products.length,
    analyzedProductCount: productAnalyses.length,
    pendingProductCount: project.products.length - productAnalyses.length,
    savedMatchCount: matches.filter(match => match.productPath).length,
    allowedAngles: [...SCENE_ANGLES],
  }
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  }
})

server.registerTool('list_product_angle_tasks', {
  title: 'List product reference angle tasks',
  description: 'List Image 2 product references and their angle-analysis status. Use pendingOnly to prevent repeated visual reads.',
  inputSchema: {
    projectPath: z.string().min(1),
    pendingOnly: z.boolean().default(true),
  },
  annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
}, async ({ projectPath, pendingOnly }) => {
  const project = await scanProject(projectPath)
  const analyses = await getProductAngleAnalyses(project.products)
  const byPath = new Map(analyses.map(analysis => [analysis.productPath, analysis]))
  const groupByPath = new Map(project.productGroups.flatMap(group => group.images.map(path => [path, group.name] as const)))
  const tasks = project.products.map(productPath => ({
    productPath,
    filename: basename(productPath),
    groupName: groupByPath.get(productPath) || '全部素材',
    status: byPath.has(productPath) ? 'analyzed' : 'pending',
    analysis: byPath.get(productPath) || null,
  })).filter(task => !pendingOnly || task.status === 'pending')
  return {
    structuredContent: { projectPath: project.root, tasks },
    content: [{ type: 'text', text: JSON.stringify({ projectPath: project.root, tasks }, null, 2) }],
  }
})

server.registerTool('get_product_reference_image', {
  title: 'Get Image 2 product reference',
  description: 'Return one controlled product reference image for angle analysis. Read each pending reference once.',
  inputSchema: {
    projectPath: z.string().min(1),
    productPath: z.string().min(1),
  },
  annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
}, async ({ projectPath, productPath }) => {
  await requireProjectProduct(projectPath, productPath)
  const source = await readFile(productPath)
  const image = await sharp(source).rotate().resize(1280, 1280, {
    fit: 'inside', withoutEnlargement: true,
  }).jpeg({ quality: 84, progressive: true }).toBuffer()
  const summary = {
    productPath,
    filename: basename(productPath),
    existingAnalysis: await getProductAngleAnalysis(productPath) || null,
    angleConvention: {
      front: 0, front_right: 45, right: 90, back_right: 135,
      back: 180, back_left: 225, left: 270, front_left: 315,
      strictFrontToleranceDegrees: 10,
      perspectiveRule: 'Visible bilateral perspective is front_right/front_left even when close to frontal',
      sideConvention: 'right means the chair-front/seat axis points toward image-right; left means it points toward image-left',
    },
  }
  return {
    structuredContent: summary,
    content: [
      { type: 'text', text: JSON.stringify(summary, null, 2) },
      { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
    ],
  }
})

server.registerTool('save_product_angle_analysis', {
  title: 'Save Image 2 product angle analysis',
  description: 'Save one idempotent structured angle result for a controlled product reference. This never calls a generation API.',
  inputSchema: {
    projectPath: z.string().min(1),
    productPath: z.string().min(1),
    angle: angleSchema,
    azimuth: z.number().min(0).max(359.9).nullable(),
    elevation: z.number().min(-90).max(90).nullable().default(0),
    mirrored: z.boolean().default(false),
    occlusion: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    chairCount: z.number().int().min(0).max(20).default(1),
    reason: z.string().min(1).max(1000),
  },
  annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
}, async ({ projectPath, productPath, ...analysis }) => {
  await requireProjectProduct(projectPath, productPath)
  const saved = await saveProductAngleAnalysis(productPath, analysis, { source: 'agent' })
  return {
    structuredContent: { analysis: saved },
    content: [{ type: 'text', text: JSON.stringify({ analysis: saved }, null, 2) }],
  }
})

server.registerTool('list_scene_angle_tasks', {
  title: 'List scene angle tasks',
  description: 'List scene images and their current angle-analysis status. Use pendingOnly to avoid reviewing completed scenes repeatedly.',
  inputSchema: {
    projectPath: z.string().min(1),
    pendingOnly: z.boolean().default(true),
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
}, async ({ projectPath, pendingOnly }) => {
  const project = await scanProject(projectPath)
  const analyses = await getSceneAngleAnalyses(project.scenes)
  const byPath = new Map(analyses.map(analysis => [analysis.scenePath, analysis]))
  const tasks = project.scenes
    .map(scenePath => ({
      scenePath,
      filename: basename(scenePath),
      status: byPath.has(scenePath) ? 'analyzed' : 'pending',
      analysis: byPath.get(scenePath) || null,
    }))
    .filter(task => !pendingOnly || task.status === 'pending')
  return {
    structuredContent: { projectPath: project.root, tasks },
    content: [{ type: 'text', text: JSON.stringify({ projectPath: project.root, tasks }, null, 2) }],
  }
})

server.registerTool('get_scene_angle_image', {
  title: 'Get scene image for angle analysis',
  description: 'Return one controlled scene image for visual angle analysis. Call this once per pending scene, then save exactly one structured analysis.',
  inputSchema: {
    projectPath: z.string().min(1),
    scenePath: z.string().min(1),
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
}, async ({ projectPath, scenePath }) => {
  await requireProjectScene(projectPath, scenePath)
  const source = await readFile(scenePath)
  const image = await sharp(source)
    .rotate()
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 84, progressive: true })
    .toBuffer()
  const existingAnalysis = await getSceneAngleAnalysis(scenePath)
  const summary = {
    scenePath,
    filename: basename(scenePath),
    existingAnalysis: existingAnalysis || null,
    angleConvention: {
      front: 0,
      front_right: 45,
      right: 90,
      back_right: 135,
      back: 180,
      back_left: 225,
      left: 270,
      front_left: 315,
      strictFrontToleranceDegrees: 10,
      perspectiveRule: 'Visible bilateral perspective is front_right/front_left even when close to frontal',
      sideConvention: 'right means the chair-front/seat axis points toward image-right; left means it points toward image-left',
    },
  }
  return {
    structuredContent: summary,
    content: [
      { type: 'text', text: JSON.stringify(summary, null, 2) },
      { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
    ],
  }
})

server.registerTool('save_scene_angle_analysis', {
  title: 'Save scene angle analysis',
  description: 'Save one idempotent structured chair-angle analysis for a scene. Repeating the same result updates the same record and never calls a paid generation API.',
  inputSchema: {
    projectPath: z.string().min(1),
    scenePath: z.string().min(1),
    angle: angleSchema,
    azimuth: z.number().min(0).max(359.9).nullable(),
    elevation: z.number().min(-90).max(90).nullable().default(0),
    mirrored: z.boolean().default(false),
    occlusion: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    chairCount: z.number().int().min(0).max(20).default(1),
    reason: z.string().min(1).max(1000),
  },
  annotations: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: false,
  },
}, async ({ projectPath, scenePath, ...analysis }) => {
  await requireProjectScene(projectPath, scenePath)
  const saved = await saveSceneAngleAnalysis(scenePath, analysis, { source: 'agent' })
  const structuredContent = { analysis: saved }
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
  }
})

server.registerTool('list_scene_angle_results', {
  title: 'List saved scene angle results',
  description: 'Return all saved scene-angle analyses for the specified project.',
  inputSchema: {
    projectPath: z.string().min(1),
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
}, async ({ projectPath }) => {
  const project = await scanProject(projectPath)
  const results = await getSceneAngleAnalyses(project.scenes)
  return {
    structuredContent: { projectPath: project.root, results },
    content: [{ type: 'text', text: JSON.stringify({ projectPath: project.root, results }, null, 2) }],
  }
})

server.registerTool('match_scene_product_angles', {
  title: 'Match scenes to Image 2 references',
  description: 'Calculate and persist the safest angle match in every product group. This only writes recommendations and never starts image generation.',
  inputSchema: {
    projectPath: z.string().min(1),
  },
  annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
}, async ({ projectPath }) => {
  const project = await scanProject(projectPath)
  const [scenes, products] = await Promise.all([
    getSceneAngleAnalyses(project.scenes),
    getProductAngleAnalyses(project.products),
  ])
  const matches = await calculateAndSaveAngleMatches(
    project.root,
    scenes,
    project.products,
    project.productGroups,
    products,
  )
  const summary = {
    projectPath: project.root,
    matches,
    autoCount: matches.filter(match => match.status === 'auto').length,
    reviewCount: matches.filter(match => match.status === 'review').length,
    unmatchedCount: matches.filter(match => match.status === 'unmatched').length,
    generationStarted: false,
  }
  return {
    structuredContent: summary,
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
  }
})

server.registerTool('list_angle_matches', {
  title: 'List saved scene to Image 2 matches',
  description: 'Read saved angle-match recommendations for review in the workbench.',
  inputSchema: { projectPath: z.string().min(1) },
  annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
}, async ({ projectPath }) => {
  const project = await scanProject(projectPath)
  const matches = await listStoredAngleMatches(project.root)
  return {
    structuredContent: { projectPath: project.root, matches },
    content: [{ type: 'text', text: JSON.stringify({ projectPath: project.root, matches }, null, 2) }],
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('SceneColor angle MCP server running on stdio')
}

main().catch(error => {
  console.error('SceneColor angle MCP server failed:', error)
  process.exit(1)
})
