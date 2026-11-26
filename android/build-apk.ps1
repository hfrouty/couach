#requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = 'Apk')]
param(
    [Parameter(Mandatory)] [string] $JdkHome,
    [Parameter(Mandatory)] [string] $PlatformJar,
    [Parameter(Mandatory)] [string] $BuildTools,
    [Parameter(Mandatory, ParameterSetName = 'Apk')] [string] $OutputApk,
    [Parameter(Mandatory, ParameterSetName = 'Bundle')] [string] $OutputAab,
    [Parameter(Mandatory, ParameterSetName = 'Bundle')] [string] $Aapt2Path,
    [Parameter(Mandatory, ParameterSetName = 'Bundle')] [string] $BundleTool,
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
$d8 = Get-RequiredPath (Join-Path $sdkBuildTools 'd8.bat')
$buildingBundle = $PSCmdlet.ParameterSetName -eq 'Bundle'
if ($buildingBundle) {
    $outputPath = $OutputAab
    $outputExtension = '.aab'
    $outputLabel = 'AAB'
    $aapt2 = Get-RequiredPath $Aapt2Path
    $bundleToolJar = Get-RequiredPath $BundleTool
    $java = Get-RequiredPath (Join-Path $jdk 'bin/java.exe')
    $jarSigner = Get-RequiredPath (Join-Path $jdk 'bin/jarsigner.exe')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
} else {
    $outputPath = $OutputApk
    $outputExtension = '.apk'
    $outputLabel = 'APK'
    $aapt2 = Get-RequiredPath (Join-Path $sdkBuildTools 'aapt2.exe')
    $zipalign = Get-RequiredPath (Join-Path $sdkBuildTools 'zipalign.exe')
    $apksigner = Get-RequiredPath (Join-Path $sdkBuildTools 'apksigner.bat')
}

$sourceRoot = Get-RequiredPath (Join-Path $PSScriptRoot 'app/src/main') 'Container'

$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($outputPath)
if ([System.IO.Path]::GetExtension($destination) -ne $outputExtension -or [System.IO.Directory]::Exists($destination)) {
    throw "Output must be a path to an $outputExtension file."
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
$linkedResources = Join-Path $buildRoot 'linked-resources.apk'
$signedOutput = Join-Path $buildRoot ('signed' + $outputExtension)
$pendingOutput = Join-Path $destinationDirectory ('.' + $buildName + $outputExtension + '.tmp')
$previousJavaHome = $env:JAVA_HOME
$keyPasswordVariable = 'STUDYMATE_KEYSTORE_PASSWORD'
if (-not [string]::IsNullOrEmpty($env:STUDYMATE_KEY_PASSWORD)) {
    $keyPasswordVariable = 'STUDYMATE_KEY_PASSWORD'
}

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
    $linkArguments = @(
        'link', '-I', $androidJar, '--manifest', $manifest, '--java', $generated,
        '-o', $linkedResources
    )
    if ($buildingBundle) {
        $linkArguments += '--proto-format'
    }
    Invoke-BuildTool $aapt2 ($linkArguments + $compiledResources)

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

    if ($buildingBundle) {
        $baseModule = Join-Path $buildRoot 'base'
        $baseArchive = Join-Path $buildRoot 'base.zip'
        $unsignedBundle = Join-Path $buildRoot 'unsigned.aab'
        [System.IO.Compression.ZipFile]::ExtractToDirectory($linkedResources, $baseModule)
        $moduleManifest = Join-Path $baseModule 'manifest'
        [void] [System.IO.Directory]::CreateDirectory($moduleManifest)
        Move-Item -LiteralPath (Join-Path $baseModule 'AndroidManifest.xml') -Destination $moduleManifest
        Copy-Item -LiteralPath $dex -Destination (Join-Path $baseModule 'dex') -Recurse
        [System.IO.Compression.ZipFile]::CreateFromDirectory($baseModule, $baseArchive)

        Invoke-BuildTool $java @('-jar', $bundleToolJar, 'build-bundle', "--modules=$baseArchive", "--output=$unsignedBundle")
        Invoke-BuildTool $jarSigner @(
            '-keystore', $signingKey, '-storepass:env', 'STUDYMATE_KEYSTORE_PASSWORD',
            '-keypass:env', $keyPasswordVariable, '-signedjar', $signedOutput, $unsignedBundle, $KeyAlias
        )
        Invoke-BuildTool $jarSigner @(
            '-verify', '-strict', '-keystore', $signingKey, '-storepass:env',
            'STUDYMATE_KEYSTORE_PASSWORD', $signedOutput, $KeyAlias
        )
        Invoke-BuildTool $java @('-jar', $bundleToolJar, 'validate', "--bundle=$signedOutput")
    } else {
        $alignedApk = Join-Path $buildRoot 'aligned.apk'
        Invoke-BuildTool $jar @('uf', $linkedResources, '-C', $dex, '.')
        Invoke-BuildTool $zipalign @('-f', '4', $linkedResources, $alignedApk)
        Invoke-BuildTool $apksigner @(
            'sign', '--ks', $signingKey, '--ks-key-alias', $KeyAlias,
            '--ks-pass', 'env:STUDYMATE_KEYSTORE_PASSWORD', '--key-pass', ('env:' + $keyPasswordVariable),
            '--v4-signing-enabled', 'false', '--out', $signedOutput, $alignedApk
        )
        Invoke-BuildTool $apksigner @('verify', '--verbose', $signedOutput)
        Invoke-BuildTool $zipalign @('-c', '4', $signedOutput)
        Invoke-BuildTool $aapt2 @('dump', 'badging', $signedOutput)
    }

    [System.IO.File]::Copy($signedOutput, $pendingOutput)
    if ([System.IO.File]::Exists($destination)) {
        [System.IO.File]::Replace($pendingOutput, $destination, [NullString]::Value)
    } else {
        [System.IO.File]::Move($pendingOutput, $destination)
    }
    Write-Output ("{0}: {1}" -f $outputLabel, $destination)
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
