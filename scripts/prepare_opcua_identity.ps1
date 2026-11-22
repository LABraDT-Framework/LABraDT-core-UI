param(
    [ValidateSet('backend', 'demo', 'lab')][string]$TargetEnvironment = 'lab',
    [string]$MavenCommand = 'mvn'
)
$ErrorActionPreference = 'Stop'
$taskVersionRoot = Split-Path -Parent $PSScriptRoot
$taskGatewayRoot = Join-Path (Split-Path -Parent $taskVersionRoot) 'GUC_AASFramework-upload/gateway'
$taskSecurityDir = Join-Path $taskVersionRoot "data/opcua-security/$TargetEnvironment"
& $MavenCommand -f (Join-Path $taskGatewayRoot 'pom.xml') -pl opcua-adapter -am install '-DskipTests'
if ($LASTEXITCODE -ne 0) { throw 'OPC UA identity preparation stopped: Maven build failed.' }
& $MavenCommand -f (Join-Path $taskGatewayRoot 'opcua-adapter/pom.xml') exec:java '-Dexec.mainClass=com.guc.security.KeyStoreLoader' "-Dguc.opcua.security-dir=$taskSecurityDir"
if ($LASTEXITCODE -ne 0) { throw 'OPC UA identity preparation failed; existing certificate files were preserved.' }
