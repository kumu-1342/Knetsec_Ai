/**
 * 采集器适配器注册表与工厂。
 *
 * 契约（docs/00 §7）：编排器只通过 {@link createCollector} 拿到适配器实例，
 * 不直接 import 具体适配器文件，这样：
 * 1. 新增适配器只需「写一个类 + 在下面注册 + seed 里登记一行数据源」，编排器零改动；
 * 2. 适配器无状态，全部复用同一个实例，避免每轮采集重复构造；
 * 3. 传入未知 adapter 时立刻抛出 VALIDATION_ERROR，而不是运行到一半才失败。
 */
import { ADAPTER_IDS, type AdapterId, type CollectorAdapter, type SourceDescriptor } from '@knetsec/shared';
import { badRequest } from '../infra/errors.js';
import { ArxivCollector } from './arxiv.js';
import { CisaKevCollector } from './cisa-kev.js';
import { GithubAdvisoriesCollector } from './github-advisories.js';
import { GithubReleasesCollector } from './github-releases.js';
import { GithubSearchCollector } from './github-search.js';
import { HtmlListCollector } from './html-list.js';
import { JsonListCollector } from './json-list.js';
import { MsrcCvrfCollector } from './msrc-cvrf.js';
import { NvdCveCollector } from './nvd-cve.js';
import { RssCollector } from './rss.js';

/** 适配器实例表：key 与 shared 的 ADAPTER_IDS 一一对应（类型层面强制完整，漏注册会编译报错）。 */
const ADAPTER_INSTANCES: Record<AdapterId, CollectorAdapter> = {
  github_advisories: new GithubAdvisoriesCollector(),
  github_search: new GithubSearchCollector(),
  github_releases: new GithubReleasesCollector(),
  nvd_cve: new NvdCveCollector(),
  cisa_kev: new CisaKevCollector(),
  msrc_cvrf: new MsrcCvrfCollector(),
  arxiv: new ArxivCollector(),
  rss: new RssCollector(),
  json_list: new JsonListCollector(),
  html_list: new HtmlListCollector(),
};

/**
 * 按数据源描述创建（获取）适配器实例。
 *
 * 为什么参数是 SourceDescriptor 而不是 adapterId：编排器与「试采」接口都持有完整
 * 的数据源对象，直接传对象可以少一次映射；适配器本身无状态，因此无需按源实例化。
 *
 * @param source 数据源描述（来自 sources 表）
 * @returns 对应适配器实例
 * @throws AppError(VALIDATION_ERROR) 当 adapter 不在支持列表内
 */
export function createCollector(source: SourceDescriptor): CollectorAdapter {
  const adapter = ADAPTER_INSTANCES[source.adapter];
  if (!adapter) {
    throw badRequest('不支持的数据源适配器: ' + String(source.adapter), {
      supported: [...ADAPTER_IDS],
    });
  }
  return adapter;
}

/** 返回全部已注册的适配器 ID（面板/文档展示用，顺序与 shared 保持一致）。 */
export function listAdapterIds(): AdapterId[] {
  return [...ADAPTER_IDS];
}

/** 返回适配器实例（按 ID），供「适配器自检」脚本或测试使用。 */
export function getCollectorById(id: AdapterId): CollectorAdapter | undefined {
  return ADAPTER_INSTANCES[id];
}

export {
  ArxivCollector,
  CisaKevCollector,
  GithubAdvisoriesCollector,
  GithubReleasesCollector,
  GithubSearchCollector,
  HtmlListCollector,
  JsonListCollector,
  MsrcCvrfCollector,
  NvdCveCollector,
  RssCollector,
};
