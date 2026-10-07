# Opens a small dialog to save your Google OAuth Client ID for the extension.
# The ID is written to config.json in the extension folder (git-ignored);
# the extension reads it the next time it starts or refreshes.
#
# Run:  powershell -STA -ExecutionPolicy Bypass -File tools\set-client-id.ps1

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
try {
  Add-Type -Namespace Native -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [void][Native.Dpi]::SetProcessDPIAware()
} catch {}

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
$current = ''
if (Test-Path $configPath) {
  try { $current = (Get-Content $configPath -Raw | ConvertFrom-Json).clientId } catch {}
}

$font = New-Object System.Drawing.Font('Segoe UI', 10)
$width = 460

$form = New-Object System.Windows.Forms.Form -Property @{
  Text            = 'Task List Colors'
  FormBorderStyle = 'FixedDialog'
  MaximizeBox     = $false
  MinimizeBox     = $false
  StartPosition   = 'CenterScreen'
  TopMost         = $true
  AutoSize        = $true
  AutoSizeMode    = 'GrowAndShrink'
  Font            = $font
  BackColor       = [System.Drawing.Color]::White
  Padding         = New-Object System.Windows.Forms.Padding(20, 16, 20, 12)
}

$layout = New-Object System.Windows.Forms.TableLayoutPanel -Property @{
  ColumnCount  = 1
  AutoSize     = $true
  AutoSizeMode = 'GrowAndShrink'
  Dock         = 'Fill'
}

function New-Label($text, $style = 'Regular', $size = 10, $color = $null) {
  $label = New-Object System.Windows.Forms.Label -Property @{
    Text        = $text
    AutoSize    = $true
    MaximumSize = New-Object System.Drawing.Size($width, 0)
    Margin      = New-Object System.Windows.Forms.Padding(0, 0, 0, 8)
    Font        = New-Object System.Drawing.Font('Segoe UI', $size, [System.Drawing.FontStyle]::$style)
  }
  if ($color) { $label.ForeColor = $color }
  return $label
}

$title = New-Label 'OAuth client ID' 'Bold' 12
$help = New-Label ("Paste the Client ID from Google Cloud (Google Auth Platform > Clients). " +
  "It ends in .apps.googleusercontent.com.`r`nDon't paste the client secret; the extension doesn't need it.") 'Regular' 9.5 ([System.Drawing.Color]::FromArgb(68, 71, 70))

$box = New-Object System.Windows.Forms.TextBox -Property @{
  Width  = $width
  Text   = $current
  Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 4)
}

$err = New-Label '' 'Regular' 9.5 ([System.Drawing.Color]::FromArgb(179, 38, 30))
$err.Visible = $false

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel -Property @{
  FlowDirection = 'RightToLeft'
  AutoSize      = $true
  AutoSizeMode  = 'GrowAndShrink'
  Dock          = 'Fill'
  Margin        = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)
}
$save = New-Object System.Windows.Forms.Button -Property @{ Text = 'Save'; AutoSize = $true; MinimumSize = New-Object System.Drawing.Size(88, 30) }
$cancel = New-Object System.Windows.Forms.Button -Property @{ Text = 'Cancel'; AutoSize = $true; MinimumSize = New-Object System.Drawing.Size(88, 30); DialogResult = 'Cancel' }
$buttons.Controls.AddRange(@($save, $cancel))

$layout.Controls.AddRange(@($title, $help, $box, $err, $buttons))
$form.Controls.Add($layout)
$form.AcceptButton = $save
$form.CancelButton = $cancel

$save.Add_Click({
  $value = $box.Text.Trim()
  if ($value -match '^GOCSPX-') {
    $err.Text = "That's the client secret. Paste the Client ID instead (it ends in .apps.googleusercontent.com)."
    $err.Visible = $true
    $box.SelectAll(); $box.Focus()
    return
  }
  if ($value -notmatch '^[\w-]+\.apps\.googleusercontent\.com$') {
    $err.Text = "That doesn't look like a Client ID. It should end in .apps.googleusercontent.com."
    $err.Visible = $true
    $box.SelectAll(); $box.Focus()
    return
  }
  $json = @{ clientId = $value } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  $form.Tag = 'saved'
  $form.Close()
})

$form.Add_Shown({ $form.Activate(); $box.Focus() })
[void]$form.ShowDialog()

if ($form.Tag -eq 'saved') {
  [void][System.Windows.Forms.MessageBox]::Show(
    "Saved.`r`n`r`nReload Google Calendar (or click the extension's toolbar icon), then click Connect.",
    'Task List Colors', 'OK', 'Information')
  Write-Output 'saved'
} else {
  Write-Output 'cancelled'
}
