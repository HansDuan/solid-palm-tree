import './globals.css';

export const metadata = {
  title: 'ClassPilot 智课领航员',
  description: '面向高校教师的对话式教学管理智能体',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
