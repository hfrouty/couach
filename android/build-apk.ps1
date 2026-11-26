#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $JdkHome,
    [Parameter(Mandatory)] [string] $PlatformJar,
    [Parameter(Mandatory)] [string] $BuildTools,
    [Parameter(Mandatory)] [string] $OutputApk,
    [Parameter(Mandatory)] [string] $KeyStore,
    [Parameter(Mandatory)] [string] $KeyAlias,
    [switch] $KeepBuildDirectory
)

$ErrorActionPreference = 'Stop'

function Get-RequiredPath {
    param([string] $FilePath, [string] $PathType = 'Leaf')
    if (-not (Test-Path -LiteralPath $FilePath -PathType $PathType)) {
        throw "Required $PathType is missing: $FilePath"
    }
    return (Resolve-Path -LiteralPath $FilePath).ProviderPath
}

function Invoke-BuildTool {
    param([string] $Executable, [string[]] $Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$(Split-Path -Leaf $Executable) failed with exit code $LASTEXITCODE."
    }
}

if ([string]::IsNullOrEmpty($env:STUDYMATE_KEYSTORE_PASSWORD)) {
    throw 'Set STUDYMATE_KEYSTORE_PASSWORD in the current process before building.'
}

$jdk = Get-RequiredPath $JdkHome 'Container'
$androidJar = Get-RequiredPath $PlatformJar
$sdkBuildTools = Get-RequiredPath $BuildTools 'Container'
$signingKey = Get-RequiredPath $KeyStore
$javac = Get-RequiredPath (Join-Path $jdk 'bin/javac.exe')
$jar = Get-RequiredPath (Join-Path $jdk 'bin/jar.exe')
$aapt2 = Get-RequiredPath (Join-Path $sdkBuildTools 'aapt2.exe')
$zipalign = Get-RequiredPath (Join-Path $sdkBuildTools 'zipalign.exe')
$d8 = Get-RequiredPath (Join-Path $sdkBuildTools 'd8.bat')
$apksigner = Get-RequiredPath (Join-Path $sdkBuildTools 'apksigner.bat')

$sourceRoot = Get-RequiredPath (Join-Path $PSScriptRoot 'app/src/main') 'Container'

$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputApk)
if ([System.IO.Path]::GetExtension($destination) -ne '.apk' -or [System.IO.Directory]::Exists($destination)) {
    throw 'OutputApk must be a path to an .apk file.'
}
$destinationDirectory = [System.IO.Path]::GetDirectoryName($destination)
[void] [System.IO.Directory]::CreateDirectory($destinationDirectory)

$tempRoot = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).ProviderPath
$buildName = 'studymate-android-' + [guid]::NewGuid().ToString('N')
$buildRoot = Join-Path $tempRoot $buildName
$stagedSource = Join-Path $buildRoot 'source'
$generated = Join-Path $buildRoot 'generated'
$classes = Join-Path $buildRoot 'classes'
$dex = Join-Path $buildRoot 'dex'
$compiledResources = Join-Path $buildRoot 'resources.zip'
$classArchive = Join-Path $buildRoot 'classes.jar'
$unsignedApk = Join-Path $buildRoot 'unsigned.apk'
$alignedApk = Join-Path $buildRoot 'aligned.apk'
$signedApk = Join-Path $buildRoot 'signed.apk'
$pendingOutput = Join-Path $destinationDirectory ('.' + $buildName + '.apk.tmp')
$previousJavaHome = $env:JAVA_HOME

try {
    $env:JAVA_HOME = $jdk
    foreach ($directory in @($generated, $classes, $dex)) {
        [void] [System.IO.Directory]::CreateDirectory($directory)
    }

    # Windows Android tools may fail to open source paths containing non-ASCII characters.
    Copy-Item -LiteralPath $sourceRoot -Destination $stagedSource -Recurse
    $manifest = Get-RequiredPath (Join-Path $stagedSource 'AndroidManifest.xml')
    $resources = Get-RequiredPath (Join-Path $stagedSource 'res') 'Container'
    $javaRoot = Get-RequiredPath (Join-Path $stagedSource 'java') 'Container'
    $manifestXml = [xml] (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8)
    $usesSdk = $manifestXml.SelectSingleNode('/manifest/uses-sdk')
    if ($null -eq $usesSdk) {
        throw 'AndroidManifest.xml must declare uses-sdk.'
    }
    $minSdk = $usesSdk.GetAttribute('minSdkVersion', 'http://schemas.android.com/apk/res/android')
    if ($minSdk -notmatch '^[1-9][0-9]*$') {
        throw 'AndroidManifest.xml must declare a numeric minSdkVersion.'
    }

    Invoke-BuildTool $aapt2 @('compile', '--dir', $resources, '-o', $compiledResources)
    Invoke-BuildTool $aapt2 @(
        'link', '-I', $androidJar, '--manifest', $manifest, '--java', $generated,
        '-o', $unsignedApk, $compiledResources
    )

    $javaSources = @(
        Get-ChildItem -LiteralPath $javaRoot, $generated -Filter '*.java' -Recurse -File |
            ForEach-Object { $_.FullName }
    )
    if ($javaSources.Count -eq 0) {
        throw 'No Java source files were found.'
    }
    $javacArgs = @('--release', '8', '-encoding', 'UTF-8', '-classpath', $androidJar, '-d', $classes)
    Invoke-BuildTool $javac ($javacArgs + $javaSources)
    Invoke-BuildTool $jar @('cf', $classArchive, '-C', $classes, '.')
    Invoke-BuildTool $d8 @('--release', '--lib', $androidJar, '--min-api', $minSdk, '--output', $dex, $classArchive)
    Invoke-BuildTool $jar @('uf', $unsignedApk, '-C', $dex, '.')

    Invoke-BuildTool $zipalign @('-f', '4', $unsignedApk, $alignedApk)
    $keyPasswordVariable = 'STUDYMATE_KEYSTORE_PASSWORD'
    if (-not [string]::IsNullOrEmpty($env:STUDYMATE_KEY_PASSWORD)) {
        $keyPasswordVariable = 'STUDYMATE_KEY_PASSWORD'
    }
    Invoke-BuildTool $apksigner @(
        'sign', '--ks', $signingKey, '--ks-key-alias', $KeyAlias,
        '--ks-pass', 'env:STUDYMATE_KEYSTORE_PASSWORD', '--key-pass', ('env:' + $keyPasswordVariable),
        '--v4-signing-enabled', 'false', '--out', $signedApk, $alignedApk
    )
    Invoke-BuildTool $apksigner @('verify', '--verbose', $signedApk)
    Invoke-BuildTool $zipalign @('-c', '4', $signedApk)
    Invoke-BuildTool $aapt2 @('dump', 'badging', $signedApk)

    [System.IO.File]::Copy($signedApk, $pendingOutput)
    if ([System.IO.File]::Exists($destination)) {
        [System.IO.File]::Replace($pendingOutput, $destination, [NullString]::Value)
    } else {
        [System.IO.File]::Move($pendingOutput, $destination)
    }
    Write-Output "APK: $destination"
} finally {
    $env:JAVA_HOME = $previousJavaHome
    if ([System.IO.File]::Exists($pendingOutput)) {
        Remove-Item -LiteralPath $pendingOutput -Force
    }

    if (Test-Path -LiteralPath $buildRoot -PathType Container) {
        if ($KeepBuildDirectory) {
            Write-Output "Build files: $buildRoot"
        } else {
            $buildDirectory = Get-Item -LiteralPath $buildRoot
            $resolvedBuild = (Resolve-Path -LiteralPath $buildRoot).ProviderPath
            $separator = [System.IO.Path]::DirectorySeparatorChar
            if ($resolvedBuild -eq $buildRoot -and
                $buildDirectory.Parent.FullName.TrimEnd($separator) -eq $tempRoot.TrimEnd($separator) -and
                $buildDirectory.Name -eq $buildName -and
                -not ($buildDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
            } else {
                Write-Warning "Temporary build directory could not be verified: $buildRoot"
            }
        }
    }
}
