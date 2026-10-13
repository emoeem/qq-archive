/**
 * 导入器注册表：格式 → 导入器实例。
 *
 * 注册顺序不影响 `detectFormat` 的判定，只影响 `listImporters()` 的输出顺序。
 */
import type { DetectedFormat, Importer } from '../importer.ts';
import { GenericJsonlImporter } from './generic-jsonl.ts';
import { HtmlImporter } from './html.ts';
import { QceJsonImporter } from './qce-json.ts';
import { QceJsonlImporter } from './qce-jsonl.ts';
import { QceTxtImporter } from './qce-txt.ts';

export const IMPORTERS: Importer[] = [
  new QceJsonImporter(),
  new QceJsonlImporter(),
  new QceTxtImporter(),
  new GenericJsonlImporter(),
  new HtmlImporter(),
];

/** 各导入器的名字与可处理格式（CLI / 文档用）。 */
export function listImporters(): Array<{ name: string; formats: DetectedFormat[] }> {
  return IMPORTERS.map((importer) => ({
    name: importer.name,
    formats: [...importer.formats],
  }));
}

/** 找到能处理该格式的导入器；没有则返回 null。 */
export function importerForFormat(format: DetectedFormat): Importer | null {
  return IMPORTERS.find((importer) => importer.formats.includes(format)) ?? null;
}

export { GenericJsonlImporter } from './generic-jsonl.ts';
export { HTML_FORMAT, HtmlImporter, isMessageContainerClass, looksLikeChatHtml } from './html.ts';
export { QceJsonImporter } from './qce-json.ts';
export { QceJsonlImporter } from './qce-jsonl.ts';
export { QceTxtImporter } from './qce-txt.ts';
