/**
 * 管理面板前端入口。
 *
 * 为什么在这里统一装配 Element Plus：全站组件、指令（v-loading）、消息框都依赖
 * 同一个插件实例；locale 显式传 `zhCn`，保证分页器、日期选择器等内置文案是中文，
 * 而不是依赖浏览器语言或额外引入 ConfigProvider 组件。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';

import App from './App.vue';
import router from './router';
import './styles/index.css';

const app = createApp(App);

// 必须先装 Pinia：路由守卫里会调用 useAuthStore()，此时需要已激活的 Pinia 实例。
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

app.mount('#app');
