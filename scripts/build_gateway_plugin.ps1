$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildDirectory = '/tmp/labradt-plugin-' + [guid]::NewGuid().ToString('N')
$packageDirectory = Join-Path $projectDirectory 'data/plugin-packages'
Push-Location $projectDirectory
try {
    docker compose -p ui_v09 cp ./examples/gateway-modbus-plugin "gateway:$buildDirectory"
    if ($LASTEXITCODE) { throw 'Start the Gateway container first.' }
    docker compose -p ui_v09 exec -T gateway mvn -f "$buildDirectory/pom.xml" -DskipTests package
    if ($LASTEXITCODE) { throw 'Plugin compilation failed.' }
    New-Item -ItemType Directory -Force -Path $packageDirectory | Out-Null
    docker compose -p ui_v09 cp "gateway:$buildDirectory/target/gateway-modbus-plugin-0.9.1.jar" "$packageDirectory/gateway-modbus-plugin-0.9.1.jar"
    if ($LASTEXITCODE) { throw 'Could not retrieve the compiled package.' }
    Write-Output "Ready to upload: $packageDirectory/gateway-modbus-plugin-0.9.1.jar"
} finally { Pop-Location }
