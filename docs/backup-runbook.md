# 数据库备份与密钥出镜像 Runbook（2026-07-03）

对应优化项 ID1（密钥不进镜像）/ ID2（每日自动备份）/ ID3（残骸隔离）。
仓库内改动已完成：`.dockerignore`（排除 `_server_snapshot`/`backups`）、`docker-compose.yml`（origin-web/origin-worker 挂载 `./backups` 并固化 `ORIGIN_SQLITE_BACKUP_DIR`）、`.gitignore`（`backups/`）、`tsconfig.json`（exclude 补 `data`）。
以下是需要在**你 Mac** 和**服务器**上执行的部分。命令都可直接粘贴；`<服务器IP>` 按你平时登录方式替换。

---

## 一、你 Mac 上（三件事）

### 0. 先把隔离区移出仓库（2026-07-03 验收修正）

隔离区曾临时放在 `data/_quarantine_20260703/`（沙箱只能在仓库文件夹内移动），按"仓库外隔离"口径需要你补最后一步：

```bash
mkdir -p ~/Documents/origin-quarantine
mv ~/Documents/origin/data/_quarantine_20260703 ~/Documents/origin-quarantine/20260703
cd ~/Documents/origin && npm run typecheck   # 应通过
```

> 背景：隔离区里的旧快照含 7973 个 TS 文件，曾污染 typecheck 扫描集；`tsconfig.json` 已补 `data` 排除作长期兜底（data 是容器挂载的运行时目录，本就不该进类型检查范围）。移出后这层兜底依然保留。

### 1. 真实跑一次备份（活库实跑验证）

```bash
cd ~/Documents/origin
ORIGIN_SQLITE_BACKUP_DIR=data/backups/auto npm run backup:sqlite
```

预期输出一行 JSON，包含 `"ok":true` 和备份文件路径；脚本内置完整性校验（integrity_check 不过会直接报错退出）。
然后确认文件存在且约 240M+：

```bash
ls -lh data/backups/auto/
```

### 2.（可选，建议开）本地每日 04:30 自动备份

仓库里已放好 launchd 配置 `deploy/origin-backup.launchd.plist`：

```bash
cp ~/Documents/origin/deploy/origin-backup.launchd.plist ~/Library/LaunchAgents/com.origin.sqlite-backup.plist
launchctl load ~/Library/LaunchAgents/com.origin.sqlite-backup.plist
```

次日看 `data/backups/auto/` 有没有新文件即可。若日志报 npm 找不到：说明 launchd 没吃到你的 shell 环境，把 plist 里 `/bin/zsh -lc` 那行保持不动再试一次（-l 会加载你的 profile），仍不行截图发我。
卸载（回滚）：`launchctl unload ~/Library/LaunchAgents/com.origin.sqlite-backup.plist` 后删掉该文件。

---

## 二、服务器上（按顺序，约 10 分钟）

前提：先在 Mac 上提交推送（注意 `tsconfig.json` 必须在内，那是 typecheck 修复的关键）：

```bash
git add .dockerignore .gitignore docker-compose.yml tsconfig.json docs/backup-runbook.md deploy/origin-backup.launchd.plist
git commit -m "备份自动化+密钥出镜像+tsconfig排除data(ID1/ID2/ID3就绪)"
git push
```

### 1. 摸底（只读，先看现状）

```bash
cd /var/www/myapp
df -h / | tail -1                          # 磁盘余量，够不够 ~3.5G 备份
du -sh data/* 2>/dev/null | sort -rh | head -8   # 服务器 data/ 有没有同类残骸堆积
grep -c BACKUP .env || true                # 服务器 .env 是否已设过备份变量（compose 已固化，不设也行）
crontab -l                                 # 现有定时任务
```

> 若 `du` 显示服务器也有 backups/corrupt-backups 堆积：先别删，把输出发我，走和本地一样的"清单→隔离"流程。
> 若磁盘余量 < 10G：把保留份数降一半——在 `/var/www/myapp/.env` 里加一行 `ORIGIN_SQLITE_BACKUP_RETAIN=7`。

### 2. 拉代码 + 重建镜像（同时完成 ID1 密钥出镜像）

```bash
cd /var/www/myapp
git pull
docker compose config >/dev/null && echo compose-ok   # 语法+插值真校验（本地无docker只做过YAML解析）
docker compose build
docker compose up -d
```

验证密钥确实不在镜像里（应输出 No such file）：

```bash
docker compose exec origin-web ls /app/_server_snapshot 2>&1
docker compose exec origin-web ls /app/backups 2>&1
```

清掉含旧密钥拷贝的历史镜像层：

```bash
docker image prune -f
```

### 3. 手动跑一次备份（验证链路通）

```bash
cd /var/www/myapp
mkdir -p backups
docker compose exec -T origin-worker npm run backup:sqlite
ls -lh backups/
```

预期：JSON 带 `"ok":true`；`backups/` 出现 `qd.sqlite.<时间戳>.bak`，约 240M+。

### 4. 加每日 04:00 定时

```bash
( crontab -l 2>/dev/null; echo '0 4 * * * cd /var/www/myapp && docker compose exec -T origin-worker npm run backup:sqlite >> /var/www/myapp/backups/backup.log 2>&1' ) | crontab -
crontab -l   # 确认那行进去了
```

次日检查：`ls -lh /var/www/myapp/backups/` 应有当天文件；`tail backups/backup.log` 应见 `"ok":true`。
回滚：`crontab -e` 删掉那一行即可。

### 5. 每周拉一份到 Mac（异机副本）

在 **Mac** 上执行（建议每周一次，可加日历提醒）：

```bash
mkdir -p ~/Documents/origin-db-backups
rsync -az --progress root@<服务器IP>:/var/www/myapp/backups/ ~/Documents/origin-db-backups/
```

> 真正的云端异地备份（对象存储）列为后续待议项，本期先保证"服务器每日 + Mac 每周"两层。

---

## 三、密钥轮换判定（ID1 遗留决策）

先看镜像是否只存在于服务器本机、从没推到过外部 registry：

```bash
docker images | grep origin        # 只有本机 tag、无 registry 前缀（如 xxx.com/origin）即为未推过
```

未推过 → **不需要轮换**（服务器本来就持有活的 .env，镜像层那份拷贝没有扩大暴露面），做完上面第 2 步即闭环。
若推过或拿不准 → 最小轮换 `JWT_SECRET` / `ADMIN_JWT_SECRET`（代价：全体用户重新登录），各家 API key 在供应商后台重置，改完 `docker compose up -d` 重启生效。

---

## 四、完成标准 & 回滚总表

状态口径（仓库改动只算"就绪"，不算完成）：
- **ID1 完成** = 服务器重建镜像 + `ls /app/_server_snapshot` 确认不存在 + `docker image prune`；
- **ID2 完成** = 连续两天服务器 `backups/` 自动出现当天备份文件 + Mac 有一份异机副本；
- **ID3 完成** = 隔离区已移出仓库（上文第 0 步）+ 观察 2 周无异常 + 真删另行批准。

| 动作 | 回滚 |
|------|------|
| .dockerignore/.gitignore/compose/tsconfig 改动 | `git revert` 对应提交 |
| 服务器 cron | `crontab -e` 删行 |
| Mac launchd | `launchctl unload` + 删 plist |
| 残骸隔离 | `~/Documents/origin-quarantine/20260703/`（移出前在 `data/_quarantine_20260703/`）按 MANIFEST.txt 原始清单 mv 回原位，未删除任何文件 |
| 镜像重建 | 按旧 tag 回退（prune 前旧镜像仍在） |
