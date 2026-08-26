const TELEGRAM_CHAT_ID = '844300387';

const clean = (value, maxLength) => String(value ?? '')
  .replace(/\u0000/g, '')
  .trim()
  .slice(0, maxLength);

const consentGranted = value => value === true || ['true', 'on', 'yes', '1'].includes(String(value).toLowerCase());

const fetchWithTimeout = async (url, options, timeoutMs = 10000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const isConfirmedSheetsResponse = (responseText) => {
  const normalized = responseText.trim().toLowerCase();
  if (['ok', 'success'].includes(normalized)) return true;

  try {
    const result = JSON.parse(responseText);
    return result?.ok === true
      || result?.success === true
      || String(result?.status || '').toLowerCase() === 'success'
      || String(result?.result || '').toLowerCase() === 'success';
  } catch {
    return false;
  }
};

module.exports = async function telegramHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Метод не поддерживается.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'Не удалось прочитать данные заявки.' });
    }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'Не удалось прочитать данные заявки.' });
  }

  const name = clean(body.name, 120);
  const phone = clean(body.phone, 80);
  const telegram = clean(body.telegram, 120);
  const tariff = clean(body.tariff, 200);
  const comment = clean(body.comment, 1500);

  if (!name || !phone || !tariff) {
    return res.status(400).json({ ok: false, error: 'Заполните имя, телефон и выберите вариант размещения.' });
  }

  if (!consentGranted(body.personal_data_consent) || !consentGranted(body.public_offer_accepted)) {
    return res.status(400).json({ ok: false, error: 'Для отправки заявки необходимо принять оба согласия.' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const sheetsSecret = process.env.GOOGLE_SHEETS_SECRET;
  const sheetsWebhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!token || !sheetsSecret || !sheetsWebhookUrl) {
    console.error('One or more server integrations are not configured');
    return res.status(500).json({ ok: false, error: 'Сервис отправки временно недоступен. Попробуйте позже.' });
  }

  let parsedSheetsUrl;
  try {
    parsedSheetsUrl = new URL(sheetsWebhookUrl);
  } catch {
    console.error('GOOGLE_SHEETS_WEBHOOK_URL is invalid');
    return res.status(500).json({ ok: false, error: 'Сервис сохранения заявок временно недоступен. Попробуйте позже.' });
  }

  if (parsedSheetsUrl.protocol !== 'https:' || parsedSheetsUrl.hostname !== 'script.google.com') {
    console.error('GOOGLE_SHEETS_WEBHOOK_URL has an unsupported origin');
    return res.status(500).json({ ok: false, error: 'Сервис сохранения заявок временно недоступен. Попробуйте позже.' });
  }

  const receivedAt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Simferopol',
    dateStyle: 'long',
    timeStyle: 'medium'
  }).format(new Date());

  const text = [
    '🔔 Новая заявка — «Контакт с телом»',
    '',
    `👤 Имя: ${name}`,
    `📞 Телефон: ${phone}`,
    `✈️ Telegram: ${telegram || '—'}`,
    `🏕 Размещение: ${tariff}`,
    `💬 Комментарий: ${comment || '—'}`,
    '',
    `🕒 Получено: ${receivedAt} (МСК)`
  ].join('\n');

  try {
    const telegramResponse = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });

    const telegramResult = await telegramResponse.json().catch(() => null);
    if (!telegramResponse.ok || !telegramResult?.ok) {
      console.error('Telegram API rejected the request', {
        status: telegramResponse.status,
        description: telegramResult?.description || 'Unknown Telegram API error'
      });
      return res.status(502).json({ ok: false, error: 'Не удалось отправить заявку в Telegram. Попробуйте ещё раз позже.' });
    }

  } catch (error) {
    console.error('Telegram request failed', { name: error?.name || 'Error' });
    return res.status(502).json({ ok: false, error: 'Не удалось отправить заявку в Telegram. Проверьте соединение и попробуйте ещё раз.' });
  }

  try {
    const sheetsResponse = await fetchWithTimeout(parsedSheetsUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: sheetsSecret,
        name,
        phone,
        telegram,
        accommodation: tariff,
        comment
      })
    });
    const sheetsResponseText = await sheetsResponse.text();

    if (!sheetsResponse.ok || !isConfirmedSheetsResponse(sheetsResponseText)) {
      console.error('Google Sheets webhook rejected the request', { status: sheetsResponse.status });
      return res.status(502).json({
        ok: false,
        partial: true,
        telegramSent: true,
        sheetsSaved: false,
        error: 'Заявка отправлена организатору, но временно не сохранена в таблице. Не отправляйте её повторно — мы уже получили ваши данные.'
      });
    }
  } catch (error) {
    console.error('Google Sheets request failed', { name: error?.name || 'Error' });
    return res.status(502).json({
      ok: false,
      partial: true,
      telegramSent: true,
      sheetsSaved: false,
      error: 'Заявка отправлена организатору, но временно не сохранена в таблице. Не отправляйте её повторно — мы уже получили ваши данные.'
    });
  }

  return res.status(200).json({ ok: true, telegramSent: true, sheetsSaved: true });
};
