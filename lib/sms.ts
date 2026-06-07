import { getExternalEnvValue } from './env';

type SendSmsStatus = {
  Code?: string;
  Message?: string;
};

let smsClient: any = null;
const DEFAULT_CODE_TTL_MINUTES = '5';

function smsConfigured(): boolean {
  return !!(
    smsEnv('TENCENT_SMS_SECRET_ID') &&
    smsEnv('TENCENT_SMS_SECRET_KEY') &&
    smsEnv('TENCENT_SMS_SDK_APP_ID') &&
    smsEnv('TENCENT_SMS_SIGN_NAME') &&
    smsEnv('TENCENT_SMS_TEMPLATE_ID')
  );
}

function getSmsClient() {
  if (smsClient) return smsClient;
  const tencentcloud = require('tencentcloud-sdk-nodejs-sms');
  const SmsClient = tencentcloud.sms.v20210111.Client;
  smsClient = new SmsClient({
    credential: {
      secretId: smsEnv('TENCENT_SMS_SECRET_ID'),
      secretKey: smsEnv('TENCENT_SMS_SECRET_KEY'),
    },
    region: smsEnv('TENCENT_SMS_REGION') || 'ap-guangzhou',
    profile: {
      httpProfile: {
        endpoint: 'sms.tencentcloudapi.com',
      },
    },
  });
  return smsClient;
}

export async function sendSmsCode(phone: string, code: string): Promise<void> {
  if (!smsConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[sms] Tencent SMS is not configured');
    }
    console.log(`[sms] [dev] ${phone} -> ${code} (5 min)`);
    return;
  }

  const status = await sendSmsWithParams(phone, [code]);
  if (isSmsOk(status)) return;

  // 腾讯云模板变量数必须和审核模板完全一致。默认按单变量 {1}=code 发；
  // 若真实模板是 "{1},{2}分钟内有效"，首发会返回参数不匹配，这里自动补 TTL 重试一次。
  if (isTemplateParamMismatch(status)) {
    const retryStatus = await sendSmsWithParams(phone, [code, smsCodeTtlMinutes()]);
    if (isSmsOk(retryStatus)) return;
    throw smsError(retryStatus);
  }

  throw smsError(status);
}

async function sendSmsWithParams(phone: string, params: string[]): Promise<SendSmsStatus | undefined> {
  const res = await getSmsClient().SendSms({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: smsEnv('TENCENT_SMS_SDK_APP_ID'),
    SignName: smsEnv('TENCENT_SMS_SIGN_NAME'),
    TemplateId: smsEnv('TENCENT_SMS_TEMPLATE_ID'),
    TemplateParamSet: params,
  });
  return res?.SendStatusSet?.[0];
}

function smsCodeTtlMinutes(): string {
  const raw = smsEnv('TENCENT_SMS_CODE_TTL_MINUTES');
  return raw || DEFAULT_CODE_TTL_MINUTES;
}

function smsEnv(name: string): string {
  return String(getExternalEnvValue(name) || process.env[name] || '').trim();
}

function isSmsOk(status: SendSmsStatus | undefined): boolean {
  return status?.Code === 'Ok';
}

function isTemplateParamMismatch(status: SendSmsStatus | undefined): boolean {
  return /TemplateParamSetNotMatchApprovedTemplate/i.test(`${status?.Code || ''} ${status?.Message || ''}`);
}

function smsError(status: SendSmsStatus | undefined): Error {
  return new Error(`[sms] SendSms failed: ${status?.Code || 'unknown'} ${status?.Message || ''}`.trim());
}
