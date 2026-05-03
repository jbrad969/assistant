const FORM_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSf60TVxr9WkXQTeiVAvfY1YvpIFl_6z5Giqzy0-FLlf3XRbMg/formResponse";

export async function POST(req) {
  try {
    const { customerName, customerEmail, customerAddress, roofMaterial, notes } =
      await req.json();

    if (!customerName || !customerAddress || !roofMaterial) {
      return Response.json(
        { error: "Missing customer name, address, or roof material" },
        { status: 400 }
      );
    }

    const form = new URLSearchParams();
    form.set("entry.1675329076", customerName);
    form.set("entry.278134308", customerEmail || "");
    form.set("entry.1845017790", customerAddress);
    form.set("entry.509679784", "Brad Jorgensen — Solar Fix");
    form.set("entry.1988959135", "brad@solarfixaz.com");
    form.set("entry.579568130", roofMaterial);
    form.set("entry.1378519979", notes || "");

    const res = await fetch(FORM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (!res.ok) {
      return Response.json(
        { error: `Google Forms returned ${res.status}` },
        { status: 502 }
      );
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
