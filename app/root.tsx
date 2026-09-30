import '@mantine/core/styles.css';
import './styles.css';
import { I18nProvider } from '@lingui/react';
import { MantineProvider } from '@mantine/core';
import type { ReactNode } from 'react';
import { Provider } from 'react-redux';
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { i18n } from './lib/i18n';
import { store } from './store';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head><Meta /><Links /></head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <MantineProvider defaultColorScheme="light">
      <Provider store={store}>
        <I18nProvider i18n={i18n}><Outlet /></I18nProvider>
      </Provider>
    </MantineProvider>
  );
}
