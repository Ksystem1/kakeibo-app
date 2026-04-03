/**
 * ECS 本番運用向けの案内スクリプト。
 * deploy:backend を誤って App Runner へ向けないため、実行時に正しい導線を表示する。
 */

console.error("backend の本番デプロイ先は ECS + ALB です。");
console.error("次のいずれかで実行してください:");
console.error("");
console.error("1) GitHub Actions");
console.error("   - workflow: .github/workflows/deploy.yml");
console.error("   - 手順: Actions -> Deploy backend (ECS Fargate + Terraform) -> Run workflow");
console.error("");
console.error("2) ローカル Terraform");
console.error("   - cd infra/terraform-ecs-express");
console.error("   - terraform init");
console.error("   - terraform apply");
console.error("");
console.error("App Runner を更新する場合のみ npm run deploy:backend:apprunner を使用してください。");
