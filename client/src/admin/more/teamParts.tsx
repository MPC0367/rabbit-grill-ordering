// Pieces shared by the team list and the account editor.
import { ROLES, type Role } from '../../../../shared/permissions.ts';
import { useI18n } from '../../lib/i18n.tsx';
import { ChoiceGroup, RadioCard, graphemes } from '../../ui/index.ts';

export const PASSWORD_MIN = 10;

/** Client copy of the server's password rules (the server still decides). Returns an i18n key. */
export function passwordProblem(pw: string, who: { username: string; display_name: string }): string | null {
  if (pw.length < PASSWORD_MIN) return 'team.err.passwordShort';
  const p = pw.toLowerCase();
  if ((who.username && p.includes(who.username.toLowerCase())) || (who.display_name.length >= 4 && p.includes(who.display_name.toLowerCase()))) return 'team.err.passwordName';
  return null;
}

/** "Demo Owner" → DO, "Nok" → NK, "นก" → น */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (/^[A-Za-z]/.test(words[0])) {
    const w = words[0];
    return (words.length > 1 ? w[0] + words[1][0] : w.length > 2 ? w[0] + w[w.length - 1] : w).toUpperCase();
  }
  return graphemes(words[0])[0] ?? '';
}

export function RolePicker({ value, onChange, name, disabled }: { value: Role; onChange: (r: Role) => void; name: string; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <ChoiceGroup legend={t('team.f.role')} rule={t('team.f.roleRule')} className="team-roles">
      {ROLES.map((r) => (
        <RadioCard
          key={r}
          name={name}
          value={r}
          checked={value === r}
          disabled={disabled}
          onChange={() => onChange(r)}
          label={t(`team.role.${r}`)}
          description={t(`team.role.${r}.d`)}
        />
      ))}
    </ChoiceGroup>
  );
}
