// 测试引导：让 Node 认识项目里的 "@/..." 别名（Vite 别名 Node 原生不认识）。
//
// 为什么不引入 vitest：项目现有依赖里没有测试框架，而 Node 24 自带 test runner
// 且能直接运行 .ts（类型擦除），所以这里用最小成本的方式补测试，不新增依赖。
import { register } from 'node:module'

const srcUrl = new URL('../../src/', import.meta.url).href

const hook = `
const SRC = ${JSON.stringify(srcUrl)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    let rel = specifier.slice(2);
    if (!/\\.[a-z]+$/i.test(rel)) rel += '.ts';
    return { url: SRC + rel, shortCircuit: true };
  }
  return next(specifier, context);
}
`

register(`data:text/javascript,${encodeURIComponent(hook)}`)
