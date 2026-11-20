/**
 * 展示层格式化工具。
 *
 * 为什么集中在这里：时间、数字、大小、时长的写法在全站必须一致，
 * 否则同一份数据在列表、抽屉、报告页会出现不同格式，运营阅读成本变高。
 */
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

/** 空值占位符，统一用短横线，避免表格出现空白单元格。 */
const EMPTY = '-';

/**
 * 格式化为「YYYY-MM-DD HH:mm」。
 *
 * @param value ISO 8601 时间字符串；空值/非法值返回 "-"
 * @returns 本地时区展示字符串
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const date = dayjs(value);
  return date.isValid() ? date.format('YYYY-MM-DD HH:mm') : EMPTY;
}

/**
 * 格式化为「YYYY-MM-DD」。
 *
 * @param value ISO 8601 时间字符串
 * @returns 日期字符串；非法值返回 "-"
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const date = dayjs(value);
  return date.isValid() ? date.format('YYYY-MM-DD') : EMPTY;
}

/**
 * 相对时间：今天/昨天/N 天前，超过 7 天回退到绝对时间。
 *
 * 为什么不用 dayjs 的 relativeTime 插件：情报场景更关心「是不是今天的」，
 * 自定义规则比「几小时前」更直观，也避免引入插件增加包体。
 */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const date = dayjs(value);
  if (!date.isValid()) return EMPTY;
  const today = dayjs().startOf('day');
  const diffDays = today.diff(date.startOf('day'), 'day');
  if (diffDays === 0) return `今天 ${date.format('HH:mm')}`;
  if (diffDays === 1) return `昨天 ${date.format('HH:mm')}`;
  if (diffDays > 1 && diffDays < 7) return `${diffDays} 天前`;
  return date.format('YYYY-MM-DD HH:mm');
}

/**
 * 计算并格式化耗时（采集任务、试采）。
 *
 * @param start ISO 开始时间
 * @param end ISO 结束时间；任务运行中传 null，显示 "运行中"
 * @returns 例如 "1 分 23 秒"
 */
export function formatDuration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return EMPTY;
  if (!end) return '运行中';
  const startDate = dayjs(start);
  const endDate = dayjs(end);
  if (!startDate.isValid() || !endDate.isValid()) return EMPTY;
  const totalSeconds = Math.max(0, endDate.diff(startDate, 'second'));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} 小时 ${restMinutes} 分`;
}

/**
 * 字节数转可读大小（库大小、文件下载提示）。
 *
 * @param bytes 字节数；空值返回 "-"
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return EMPTY;
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

/** 千分位数字，指标卡与统计表格使用。 */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EMPTY;
  return value.toLocaleString('zh-CN');
}

/** 截断长文本并追加省略号，防止标题撑破表格。 */
export function truncate(value: string | null | undefined, maxLength = 80): string {
  if (!value) return EMPTY;
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * 成功率百分比。
 *
 * @param success 成功次数
 * @param failure 失败次数
 * @returns 0-100 的整数；无运行记录返回 null，由页面显示 "-"
 */
export function successRate(success: number, failure: number): number | null {
  const total = success + failure;
  if (total <= 0) return null;
  return Math.round((success / total) * 100);
}

/** 把可选的时间区间转为列表查询需要的 ISO 字符串。 */
export function rangeToIso(range: [string, string] | null): { from?: string; to?: string } {
  if (!range || range.length !== 2) return {};
  const [start, end] = range;
  const from = dayjs(start).startOf('day');
  const to = dayjs(end).endOf('day');
  return {
    from: from.isValid() ? from.toISOString() : undefined,
    to: to.isValid() ? to.toISOString() : undefined,
  };
}
