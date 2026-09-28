"""
移动公众云电脑 协议常量与端点表（侧车内）。

⚠️ 凭据外置（方案 B / 2026-09-24 拍板）
--------------------------------------------------------------------------
本文件**不含任何签名凭据字面值**。`ACCESS_KEY` / `SECRET_KEY` /
`PUBLIC_KEY_PEM` / `PRIVATE_KEY_PEM` 四个值在导入时从外部加载：

  1) 环境变量（优先）
       ECLOUD_ACCESS_KEY        AccessKey 字符串
       ECLOUD_SECRET_KEY        SecretKey 字符串
       ECLOUD_RSA_PUBLIC_PEM    客户端公钥 PEM 内容（或指向它的 *_FILE）
       ECLOUD_RSA_PRIVATE_PEM   客户端私钥 PEM 内容（或指向它的 *_FILE）
  2) 凭据文件（其次）
       ECLOUD_CRED_FILE 指向的 JSON，默认 <本目录>/credentials.json
       {
         "accessKey": "...",
         "secretKey": "...",
         "rsaPublicPem":  "-----BEGIN PUBLIC KEY-----\\n...",
         "rsaPrivatePem": "-----BEGIN PRIVATE KEY-----\\n..."
       }

**缺失即报错**（`CredentialMissing`），绝不静默降级 —— 静默降级会让整条保活链
在"看似正常"的状态下失败，正是本项目最忌讳的失败模式。

本仓库为 Public：`credentials.json` 必须保持在 .gitignore 中，禁止入库。

其余常量（地址、端点、签名方式、超时、错误码）均为协议公开信息，随源码入库。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

__all__ = [
    "BASE_URL", "API_PATH", "BACKUP_DOMAINS", "ACCESS_KEY", "SECRET_KEY",
    "PUBLIC_KEY_PEM", "PRIVATE_KEY_PEM", "RSA_ENCRYPT_CHUNK", "RSA_DECRYPT_CHUNK",
    "SIGN_METHOD", "SIGN_VERSION", "HMAC_KEY_PREFIX", "API_TIMEOUT", "LOGIN_TIMEOUT",
    "USER_AGENT", "Endpoint", "LOGIN_PATHS", "COMPANY_CODE", "CLIENT_VERSION",
    "CHANNEL_VERSION", "LoginError", "LoginType", "CredentialMissing",
]


class CredentialMissing(RuntimeError):
    """凭据缺失：不静默降级，直接让侧车启动失败。"""


def _read_pem(env_content: str, env_file: str, label: str) -> str | None:
    """按 内容 → 文件 的顺序取 PEM。"""
    content = os.environ.get(env_content)
    if content and content.strip():
        return content
    path = os.environ.get(env_file)
    if path and Path(path).is_file():
        return Path(path).read_text("utf-8")
    return None


def _load_credentials() -> tuple[str, str, str, str]:
    """返回 (access_key, secret_key, public_pem, private_pem)；缺失即 CredentialMissing。"""
    ak = os.environ.get("ECLOUD_ACCESS_KEY")
    sk = os.environ.get("ECLOUD_SECRET_KEY")
    pub = _read_pem("ECLOUD_RSA_PUBLIC_PEM", "ECLOUD_RSA_PUBLIC_PEM_FILE", "公钥")
    priv = _read_pem("ECLOUD_RSA_PRIVATE_PEM", "ECLOUD_RSA_PRIVATE_PEM_FILE", "私钥")

    # 环境变量未给全 → 回落到凭据文件
    if not (ak and sk and pub and priv):
        cred_file = os.environ.get("ECLOUD_CRED_FILE") or str(
            Path(__file__).resolve().with_name("credentials.json")
        )
        p = Path(cred_file)
        if p.is_file():
            try:
                d = json.loads(p.read_text("utf-8"))
            except Exception as e:  # 显式展开，不吞错
                raise CredentialMissing(
                    f"凭据文件解析失败: {cred_file} ({type(e).__name__}: {e})"
                ) from e
            ak = ak or d.get("accessKey")
            sk = sk or d.get("secretKey")
            pub = pub or d.get("rsaPublicPem")
            priv = priv or d.get("rsaPrivatePem")

    missing = [
        name for name, val in (
            ("AccessKey", ak), ("SecretKey", sk),
            ("RSA 公钥", pub), ("RSA 私钥", priv),
        ) if not val
    ]
    if missing:
        raise CredentialMissing(
            "移动公众协议凭据缺失: " + " / ".join(missing) +
            " —— 请通过环境变量或 ECLOUD_CRED_FILE 指向的 credentials.json 提供；"
            "本文件刻意不含字面值（方案 B）。"
        )
    return ak, sk, pub, priv


_ACCESS_KEY, _SECRET_KEY, _PUBLIC_KEY_PEM, _PRIVATE_KEY_PEM = _load_credentials()

# ---------------------------------------------------------------------------
# 服务端地址
# ---------------------------------------------------------------------------
BASE_URL = "https://cloudpc.ecloud.10086.cn"
API_PATH = "/api/cem/gateway/outer/cem-webapi"
BACKUP_DOMAINS = [
    "https://cloudpc1.ecloud.10086.cn",
    "https://cloudpc2.ecloud.10086.cn",
]

# ↑ 由 _load_credentials() 在导入时填充（外置，不入库）
ACCESS_KEY = _ACCESS_KEY
SECRET_KEY = _SECRET_KEY

# ---------------------------------------------------------------------------
# RSA 密钥（1024-bit, PKCS1 padding）
#   - 公钥: 加密每个请求的 JSON body -> {"params": base64}
#   - 私钥: 解密响应 body 的 RSA 密文
# ---------------------------------------------------------------------------
PUBLIC_KEY_PEM = _PUBLIC_KEY_PEM
PRIVATE_KEY_PEM = _PRIVATE_KEY_PEM

# RSA 分块大小 (RSA-1024: 加密块 117 字节，解密块 128 字节)
RSA_ENCRYPT_CHUNK = 117   # modulusLength/8 - 11
RSA_DECRYPT_CHUNK = 128   # modulusLength/8

# ---------------------------------------------------------------------------
# 签名常量
# ---------------------------------------------------------------------------
SIGN_METHOD = "HmacSHA1"
SIGN_VERSION = "V2.0"
HMAC_KEY_PREFIX = "BC_SIGNATURE&"   # 拼在 secretKey 前作为 HMAC key

# ---------------------------------------------------------------------------
# HTTP 客户端常量
# ---------------------------------------------------------------------------
API_TIMEOUT = 30
LOGIN_TIMEOUT = 10
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "EcloudCloudComputer/3.8.2"
)

# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------
class Endpoint:
    # 登录
    LOGIN_CHECK_USER_PASSWORD = "/login/verify"
    LOGIN_GET_TOKEN           = "/login/verifyAccessTicket"
    LOGIN_CHECK_MOBILE        = "/login/checkMobile"
    LOGIN_SEND_SMS            = "/login/sendVerifySms"
    LOGIN_VERIFY_SMS          = "/login/verifySms"
    LOGIN_QR_CODE             = "/login/getQRCode"
    LOGIN_QR_LOGIN_RESULT     = "/login/getQRLoginResult"
    LOGIN_TRUST_DEVICE        = "/login/trustDevice"
    LOGIN_TEMPORARY_DEVICE    = "/login/trustOrTemporaryDevice"
    LOGIN_AUTH_TWOFACTOR_GET  = "/login/special/getSecondauthSms"
    LOGIN_AUTH_TWOFACTOR      = "/login/verifyTwoFactorAuthSms"
    LOGIN_AUTH_4A_SMS         = "/user/getUserNameBySmsAuth"
    LOGIN_AUTH_4A             = "/login/special/secondauthBy4a"
    LOGIN_ENHANCE_SMS         = "/login/verifyLoginEnhanceSms"
    LOGIN_AD_LOGIN            = "/login/adUserLogin"
    LOGIN_AD_RESULT           = "/login/getAdLoginResult"
    LOGIN_SIM_CODE            = "/login/simVerify"
    LOGIN_SIM_LOGIN_RESULT    = "/login/getSimLoginResult"
    LOGIN_NEW_BY_CODE         = "/login/loginByCode"
    LOGOUT                    = "/login/logout"

    # 用户/设备
    USER_GET_INFO             = "/user/getLoginUserInfo"
    GET_SYS_CONFIG            = "/client/getSysConfig"
    USER_GET_DEVICE_INFO      = "/user/getDeviceInfo"
    GET_SYS_TIME              = "/user/getSysTime"
    SET_NEW_PWD               = "/user/setNewPwd"

    # 探针上报 (登录态保活)
    PROBE_QKK_BATCHPUSH       = "/login/batchPushLoginQkk"

    # 桌面会话保活（抓包逆向，见 desktop_session.py）
    DESKTOP_UPTIME            = "/resource/desktopUptime"
    SESSION_MACHINE_CONNECT   = "/session/machineConnect"
    PUSH_CONNECT_EVENT        = "/machine/pushConnectEventData"
    GET_DESKTOP_LIST          = "/resource/getDesktopList"

    # 桌面列表与操作
    GET_DEVICE_INFO           = "/user/getDeviceInfo"
    GET_DESKTOP_STATUS        = "/user/getDesktopStatus"
    RESOURCE_OPERATE          = "/resource/operate"
    UPDATE_SESSION_STATUS     = "/session/updateSessionStatus"

# 登录类端点 (10s 超时 + 备用域名重试)
LOGIN_PATHS = {
    Endpoint.LOGIN_CHECK_USER_PASSWORD,
    Endpoint.LOGIN_QR_CODE,
    Endpoint.LOGIN_CHECK_MOBILE,
    Endpoint.LOGIN_AD_LOGIN,
}

# ---------------------------------------------------------------------------
# 业务常量
# ---------------------------------------------------------------------------
COMPANY_CODE   = "ECloud"
CLIENT_VERSION = "3.8.2"
CHANNEL_VERSION = "23"

# 登录错误码
class LoginError:
    UNTRUSTED_DEVICE   = "30002009"   # 未授信设备 -> 需短信信任
    TWO_FACTOR_AUTH    = "30002060"   # 二次验证
    ENHANCED_STRATEGY  = "30002063"   # 增强策略短信
    FEISHU_BIND        = "10002039"
    REFRESH_FS_QRCODE  = "30002026"

# 登录方式
class LoginType:
    PASSWORD     = 0
    SMS          = 1
    QRCODE       = 2
    SIM          = 3
    FORGET_PWD   = 4
    AD_CONNECTOR = 5
    FEISHU_QR    = 6
    MULTI_ACCT   = 7
