package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func ps(s string) error {
	return exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';"+s).Run()
}
func literal(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
func acquireForwarding() (func(), error) {
	// Serialize and reference-count the shared WinNAT, preserving pre-existing forwarding.
	common := fmt.Sprintf("$owner=%d;$dir=Join-Path $env:ProgramData 'VBNetwork';New-Item -ItemType Directory -Force $dir|Out-Null;$file=Join-Path $dir 'forwarding.json';$self=Get-Process -Id $owner;$identity=[pscustomobject]@{pid=$owner;started=$self.StartTime.ToUniversalTime().Ticks.ToString()};$mutex=New-Object Threading.Mutex($false,'Global\\VBNetworkForward');if(-not $mutex.WaitOne(10000)){throw 'network lease busy'};try{$s=$null;if(Test-Path $file){$s=Get-Content $file -Raw|ConvertFrom-Json};if($s){$s.owners=@($s.owners|Where-Object{$p=Get-Process -Id $_.pid -ErrorAction SilentlyContinue;$p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq $_.started})};", os.Getpid())
	acquire := "if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator required'};if(-not $s){$existing=Get-NetNat -ErrorAction SilentlyContinue;if($existing -and (-not(Get-NetNat -Name 'VBNetwork' -ErrorAction SilentlyContinue))){throw 'Existing WinNAT needs administrator integration'};$s=[pscustomobject]@{owners=@();natOwned=(-not $existing);interfaces=@(Get-NetIPInterface -AddressFamily IPv4|Select-Object InterfaceIndex,Forwarding)}};$s.owners=@($s.owners)+$identity;$s|ConvertTo-Json -Depth 5|Set-Content $file;$nat=Get-NetNat -Name 'VBNetwork' -ErrorAction SilentlyContinue;if($nat -and $nat.InternalIPInterfaceAddressPrefix -ne '198.18.0.0/15'){throw 'VBNetwork prefix conflict'};if(-not $nat){New-NetNat -Name 'VBNetwork' -InternalIPInterfaceAddressPrefix '198.18.0.0/15'|Out-Null};Get-NetIPInterface -AddressFamily IPv4|Where-Object{$_.ConnectionState -eq 'Connected'}|Set-NetIPInterface -Forwarding Enabled;$s|ConvertTo-Json -Depth 5|Set-Content $file"
	release := "if($s){$s.owners=@($s.owners|Where-Object{$_.pid -ne $owner -or $_.started -ne $identity.started});if($s.owners.Count -eq 0){foreach($i in $s.interfaces){Get-NetIPInterface -InterfaceIndex $i.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue|Set-NetIPInterface -Forwarding $i.Forwarding};if($s.natOwned){Remove-NetNat -Name 'VBNetwork' -Confirm:$false -ErrorAction SilentlyContinue};Remove-Item $file -ErrorAction SilentlyContinue}else{$s|ConvertTo-Json -Depth 5|Set-Content $file}}"
	finish := "}finally{$mutex.ReleaseMutex();$mutex.Dispose()}"
	expand := func(s string) string { return strings.ReplaceAll(s, "$", "$") }
	if e := ps(expand(common + acquire + finish)); e != nil {
		ps(expand(common + release + finish))
		return nil, e
	}
	return func() { ps(expand(common + release + finish)) }, nil
}
func configureTUN(name, client, peer, client6, peer6 string) (func(), error) {
	script := "$i=Get-NetAdapter -Name " + literal(name) + ";$i|Set-NetIPInterface -Forwarding Enabled;New-NetIPAddress -InterfaceIndex $i.ifIndex -IPAddress " + literal(peer) + " -PrefixLength 30|Out-Null"
	script = "$mutex=New-Object Threading.Mutex($false,'Global\\VBNetworkTunPool');if(-not $mutex.WaitOne(10000)){throw 'pool busy'};try{if(Get-NetIPAddress -IPAddress " + literal(peer) + " -ErrorAction SilentlyContinue){exit 42};" + script + "}finally{$mutex.ReleaseMutex();$mutex.Dispose()}"
	if e := ps(script); e != nil {
		var exit *exec.ExitError
		if errors.As(e, &exit) && exit.ExitCode() == 42 {
			return func() {}, errAddressInUse
		}
		return func() {}, fmt.Errorf("Windows NAT setup failed")
	}

	return func() {
		ps("Get-NetIPAddress -InterfaceAlias " + literal(name) + " -ErrorAction SilentlyContinue|Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue")
	}, nil
}
