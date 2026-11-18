import type {ReactNode} from "react";
import {AuthFrame} from "./_components/auth-frame";
import "./auth.css";
export default function AuthLayout({children}:{readonly children:ReactNode}){return <AuthFrame>{children}</AuthFrame>;}
