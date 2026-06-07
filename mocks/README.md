# Mocks 假数据层

本目录是所有"假数据"的来源。`app/api/*/route.ts` 里的 mock 接口都从这里读数据。

## 文件清单

| 文件 | 包含什么 |
| --- | --- |
| `user.ts` | 当前登录用户（手机号身份 mock） |
| `billing.ts` | 套餐 / 积分 / 订阅状态（默认 Free + 58 积分） |
| `projects.ts` | 项目列表（内存存储，重启清空），含创建/更新/删除函数 |
| `config.ts` | 客户端配置 + 维护横幅 + 管理面板 key 池 |
| `admin.ts` | 管理面板统计、在线用户、用量、注册用户 |
| `library.ts` | 素材库、世界观模板、BGM 库 |
| `settings.ts` | 用户的 API 配置（图片/视频/文本模型设置） |

## 怎么改假数据？

1. 直接改这些文件里的常量（比如把 `MOCK_BILLING_ME.balances.totalCredits` 改成 `1000`）。
2. 保存后浏览器刷新即可看到效果（Next.js dev 自动重载）。

## 等以后接真后端怎么办？

把 `app/api/<endpoint>/route.ts` 里的 mock 数据替换成真实的 `fetch('https://your-backend/...')` 调用即可。

举个例子，把 `app/api/projects/route.ts` 从：

```typescript
export async function GET() {
  return jsonOk({ items: listProjects(), total: listProjects().length });
}
```

改成：

```typescript
export async function GET(req: NextRequest) {
  const resp = await fetch('https://your-backend.com/api/projects', {
    headers: { Authorization: req.headers.get('authorization') || '' },
  });
  return resp;
}
```

前端代码（`public/`）完全不用动。
