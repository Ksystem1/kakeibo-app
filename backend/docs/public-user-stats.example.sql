-- 公開ランディング用 GET /user-stats の集計例（本番は backend/src/user-stats-public.mjs が同等の SQL を使用）
-- 会員の実テーブル名は kakeibo では `users`（`profiles` に相当する層を別テーブルに分けていない）
--
-- Prisma 相当の擬似コード:
--   const registered = await prisma.$queryRaw<[{ c: bigint }]>`SELECT COUNT(*)::bigint AS c FROM "User"`;
--   const online5m   = await prisma.$queryRaw<[{ c: bigint }]>
--     `SELECT COUNT(*)::bigint AS c FROM "User" WHERE "lastAccessedAt" IS NOT NULL AND "lastAccessedAt" > NOW() - INTERVAL '5 minutes'`;
--
-- MySQL（本アプリ）:
--   登録総数: SELECT COUNT(*) AS c FROM users;
--   直近5分: SELECT COUNT(*) AS c FROM users
--     WHERE last_accessed_at IS NOT NULL AND last_accessed_at >= (NOW() - INTERVAL 5 MINUTE);

SELECT COUNT(*) AS registered_count FROM users;

SELECT COUNT(*) AS online_5m_count
FROM users
WHERE last_accessed_at IS NOT NULL
  AND last_accessed_at >= (NOW() - INTERVAL 5 MINUTE);
