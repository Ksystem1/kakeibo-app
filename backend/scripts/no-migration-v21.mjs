/**
 * v21 マイグレーションは定義されていません（db/migration_v21*.sql なし）。
 * 番号は v20 の次に v22（チャット既読・編集）が追加されただけで、v22 に v21 相当の内容が統合されているわけではありません。
 */
console.log(
  [
    "[db:migrate-v21] v21 の SQL ファイルはありません。",
    "  子どものデータ分離（users.family_role の KID 等）: db/migration_v18_users_family_role.sql → npm run db:migrate-v18",
    "  チャットの family/support 区分: db/migration_v19_chat_messages_chat_scope.sql → npm run db:migrate-v19",
    "  子どもきせかえテーマ: db/migration_v20_users_kid_theme.sql → npm run db:migrate-v20",
    "  チャット既読・edited_at: db/migration_v22_chat_read_and_edit.sql → npm run db:migrate-v22",
  ].join("\n"),
);
