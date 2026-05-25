import { MOCK_CLIENT_CONFIG } from '@/mocks/config';
import { jsonOk } from '@/lib/api-helpers';
import { readSystemConfig } from '@/lib/system-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return jsonOk({
    ...MOCK_CLIENT_CONFIG,
    features: {
      ...MOCK_CLIENT_CONFIG.features,
      projectActivationGuard: readSystemConfig('frontend_project_activation_guard_enabled', true),
      scriptConsultGuard: readSystemConfig('frontend_script_consult_guard_enabled', true),
    },
  });
}
