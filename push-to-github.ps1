# Запуск: .\push-to-github.ps1 -Username YOUR_GITHUB_USERNAME
# Сначала создайте пустой репозиторий на https://github.com/new
# Имя: subscription-tracker-simple (без README, .gitignore)

param(
    [Parameter(Mandatory = $true)]
    [string]$Username
)

$url = "https://github.com/$Username/subscription-tracker-simple.git"
Set-Location $PSScriptRoot
git remote set-url origin $url
git push -u origin main
