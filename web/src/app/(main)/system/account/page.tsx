"use client";

import { useState } from "react";
import { KeyRound, LogOut, Pencil } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SettingsPage, SettingsSection, SettingsRow } from "@/components/settings-layout";
import { useCurrentUser } from "@/hooks/use-current-user";
import { auth } from "@/lib/auth";
import { getInitials } from "@/lib/utils";
import { ChangePasswordDialog } from "../../_components/sidebar/change-password-dialog";

import {ChangeUsernameDialog} from "./change-username-dialog";

export default function AccountPage() {
  const user = useCurrentUser();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [usernameOpen,setUsernameOpen]=useState(false);
  return (
    <SettingsPage title="Account">
      <SettingsSection title="Personal information">
        <SettingsRow title="Current account" description={user.email || undefined}>
          <Avatar className="size-8"><AvatarImage src={user.avatar || undefined} alt={user.name} /><AvatarFallback>{getInitials(user.name)}</AvatarFallback></Avatar>
          <span className="text-sm">{user.name}</span>
        </SettingsRow>
        <SettingsRow title="Username"><span className="text-sm text-muted-foreground">{user.username}</span><Button size="sm" variant="outline" onClick={()=>setUsernameOpen(true)}><Pencil/>Modify username</Button></SettingsRow>
      </SettingsSection>
      <SettingsSection title="Login security">
        <SettingsRow title="Login password"><Button size="sm" variant="outline" onClick={() => setPasswordOpen(true)}><KeyRound />Change password</Button></SettingsRow>
        <SettingsRow title="Log out" ><Button size="sm" variant="outline" onClick={() => { auth.clearToken(); window.location.href = "/login"; }}><LogOut />Log out</Button></SettingsRow>
      </SettingsSection>
      <ChangeUsernameDialog open={usernameOpen} onOpenChange={setUsernameOpen} username={user.username}/>
      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </SettingsPage>
  );
}
