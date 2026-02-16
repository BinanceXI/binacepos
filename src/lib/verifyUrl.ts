export function buildVerifyUrl(baseUrl: string, receiptId: string) {
  let b = (baseUrl || "").trim();
  if (!b) b = window.location.origin;

  // remove trailing slashes
  b = b.replace(/\/+$/, "");

  // HashRouter support
  if (b.includes("#")) {
    b = b.split("#")[0].replace(/\/+$/, "") + "/#";
  } else {
    b = b + "/#";
  }

  return `${b}/verify/${receiptId}`;
}
