import { PhoneNumberUtil } from 'google-libphonenumber';

const phoneUtil = PhoneNumberUtil.getInstance();

export const getCountryCallingCode = (isoCode: string | null | undefined): string => {
  if (!isoCode) return "+1"; // Default to US
  try {
    const countryCode = phoneUtil.getCountryCodeForRegion(isoCode.toUpperCase());
    // getCountryCodeForRegion returns 0 if the region is invalid
    if (countryCode === 0) return "+1";
    return `+${countryCode}`;
  } catch (e) {
    console.warn(`Could not get country code for region: ${isoCode}`, e);
    return "+1"; // Fallback
  }
};
