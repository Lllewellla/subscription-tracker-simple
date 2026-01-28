# Создаёт репозиторий на GitHub через API и пушит проект.
# Запуск: .\create-and-push-github.ps1 -Token "ghp_..."
# После использования отзови токен в GitHub → Settings → Developer settings → PATs.

param(
    [Parameter(Mandatory = $true)]
    [string]$Token
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$headers = @{
    "Authorization" = "Bearer $Token"
    "Accept"        = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}
$body = @{
    name        = "subscription-tracker-simple"
    description = "Веб-трекер подписок"
    private     = $false
} | ConvertTo-Json

Write-Host "Creating GitHub repository..."
$r = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Method Post -Headers $headers -Body $body -ContentType "application/json; charset=utf-8"
$owner = $r.owner.login
$cloneUrl = $r.clone_url
Write-Host "Created: https://github.com/$owner/subscription-tracker-simple"

$authUrl = "https://${Token}@github.com/${owner}/subscription-tracker-simple.git"
git remote set-url origin $authUrl
Write-Host "Pushing to origin main..."
git push -u origin main

git remote set-url origin "https://github.com/${owner}/subscription-tracker-simple.git"
Write-Host "Done. Repo: https://github.com/$owner/subscription-tracker-simple"
Write-Host "Revoke this token in GitHub if you shared it."
