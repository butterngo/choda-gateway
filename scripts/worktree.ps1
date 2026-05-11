[CmdletBinding()]
param(
    [Parameter(Mandatory, Position=0)]
    [ValidateSet('add','remove','list','prune')]
    [string]$Action,

    [Parameter(Position=1)]
    [string]$Branch,

    [Parameter()]
    [string]$From = 'main',

    [Parameter()]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    $root = git rev-parse --show-toplevel 2>$null
    if (-not $root) { throw "Not inside a git repository." }
    return (Resolve-Path $root).Path.Replace('/', '\')
}

function Get-WorktreePath {
    param([string]$RepoRoot, [string]$BranchName)
    $parent = Split-Path $RepoRoot -Parent
    $repoName = Split-Path $RepoRoot -Leaf
    $slug = $BranchName -replace '[\\/:]', '-'
    return Join-Path $parent "$repoName-$slug"
}

function Invoke-Add {
    param([string]$RepoRoot, [string]$BranchName, [string]$FromBranch)
    if (-not $BranchName) { throw "Usage: worktree.ps1 add <branch> [-From <base>]" }

    $path = Get-WorktreePath -RepoRoot $RepoRoot -BranchName $BranchName
    if (Test-Path $path) { throw "Path already exists: $path" }

    $existing = git -C $RepoRoot branch --list $BranchName
    if ($existing) {
        Write-Host "Adding worktree for existing branch '$BranchName' at $path"
        git -C $RepoRoot worktree add $path $BranchName
    } else {
        Write-Host "Creating branch '$BranchName' from '$FromBranch' at $path"
        git -C $RepoRoot worktree add -b $BranchName $path $FromBranch
    }

    Write-Host ""
    Write-Host "Worktree ready. cd into it with:"
    Write-Host "  Set-Location '$path'"
}

function Invoke-Remove {
    param([string]$RepoRoot, [string]$BranchName, [switch]$ForceRemove)
    if (-not $BranchName) { throw "Usage: worktree.ps1 remove <branch> [-Force]" }

    $path = Get-WorktreePath -RepoRoot $RepoRoot -BranchName $BranchName
    if (-not (Test-Path $path)) { throw "Worktree path not found: $path" }

    $args = @('worktree', 'remove', $path)
    if ($ForceRemove) { $args += '--force' }

    Write-Host "Removing worktree at $path"
    git -C $RepoRoot @args
    Write-Host "Removed. Branch '$BranchName' still exists locally; delete with: git branch -D $BranchName"
}

function Invoke-List {
    param([string]$RepoRoot)
    git -C $RepoRoot worktree list
}

function Invoke-Prune {
    param([string]$RepoRoot)
    git -C $RepoRoot worktree prune -v
}

$repo = Get-RepoRoot

switch ($Action) {
    'add'    { Invoke-Add    -RepoRoot $repo -BranchName $Branch -FromBranch $From }
    'remove' { Invoke-Remove -RepoRoot $repo -BranchName $Branch -ForceRemove:$Force }
    'list'   { Invoke-List   -RepoRoot $repo }
    'prune'  { Invoke-Prune  -RepoRoot $repo }
}
