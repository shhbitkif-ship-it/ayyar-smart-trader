package com.ayyar.smarttrader

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

private data class SizingResult(
    val allowed: Boolean,
    val lots: Double,
    val riskAmount: Double,
    val estimatedLoss: Double,
    val reason: String
)

@Composable
fun RiskCalculator() {
    var equity by remember { mutableStateOf("100000000") }
    var entry by remember { mutableStateOf("") }
    var stop by remember { mutableStateOf("") }
    var contract by remember { mutableStateOf("1") }
    var riskPercent by remember { mutableStateOf("1") }
    var dailyLoss by remember { mutableStateOf("0") }
    var drawdown by remember { mutableStateOf("0") }
    var result by remember { mutableStateOf<SizingResult?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val gold = Color(0xFFD6AD55)
    val muted = Color(0xFF9AA3B2)

    fun number(raw: String): Double? =
        raw.trim().replace(" ", "").replace(",", ".").toDoubleOrNull()

    Card(
        colors = CardDefaults.cardColors(containerColor = Color(0xFF171B24)),
        shape = RoundedCornerShape(18.dp)
    ) {
        Column(
            Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp)
        ) {
            Text("ماشین‌حساب مدیریت ریسک", color = gold, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Text(
                "حجم محاسباتی بر اساس فاصله ورود تا حد ضرر؛ این ابزار سفارش ثبت نمی‌کند.",
                color = muted, fontSize = 11.sp
            )
            RiskInput("سرمایه حساب", equity, { equity = it }, "مثلاً 100000000")
            RiskInput("قیمت ورود", entry, { entry = it }, "قیمت ورود")
            RiskInput("قیمت حد ضرر", stop, { stop = it }, "قیمت حد ضرر")
            RiskInput("ارزش هر واحد تغییر قیمت برای یک واحد قرارداد", contract, { contract = it }, "طبق مشخصات نماد/کارگزاری")
            RiskInput("ریسک هر معامله (درصد، حداکثر ۱٪)", riskPercent, { riskPercent = it }, "1")
            RiskInput("زیان روزانه فعلی (درصد)", dailyLoss, { dailyLoss = it }, "0")
            RiskInput("افت سرمایه فعلی (درصد)", drawdown, { drawdown = it }, "0")

            Button(
                onClick = {
                    val e = number(equity)
                    val p = number(entry)
                    val s = number(stop)
                    val c = number(contract)
                    val r = number(riskPercent)
                    val d = number(dailyLoss)
                    val dd = number(drawdown)
                    val invalid = e == null || p == null || s == null || c == null ||
                        r == null || d == null || dd == null ||
                        e <= 0.0 || p <= 0.0 || s <= 0.0 || c <= 0.0 ||
                        r <= 0.0 || r > 1.0 || d < 0.0 || d > 100.0 ||
                        dd < 0.0 || dd > 100.0 || p == s
                    if (invalid) {
                        error = "مقادیر را بررسی کن؛ ورود و حد ضرر باید متفاوت و ریسک حداکثر ۱٪ باشد."
                        result = null
                    } else {
                        error = null
                        result = null
                        loading = true
                        scope.launch {
                            try {
                                result = withContext(Dispatchers.IO) {
                                    calculatePositionSize(
                                        e!!, p!!, s!!, c!!, r!! / 100.0, d!! / 100.0, dd!! / 100.0
                                    )
                                }
                            } catch (t: Throwable) {
                                error = t.message ?: "محاسبه انجام نشد؛ اتصال سرور را بررسی کن."
                            } finally {
                                loading = false
                            }
                        }
                    }
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = gold, contentColor = Color(0xFF090B10))
            ) {
                Text(if (loading) "در حال محاسبه…" else "محاسبه حجم و ریسک")
            }

            error?.let { Text(it, color = Color(0xFFFF8D8D), fontSize = 12.sp) }
            result?.let { r ->
                HorizontalDivider(color = Color(0xFF343B49))
                Text(if (r.allowed) "نتیجه محاسبه" else "محاسبه مسدود شد", color = if (r.allowed) Color(0xFF8FD6A8) else Color(0xFFFF8D8D), fontWeight = FontWeight.Bold)
                if (r.allowed) {
                    RiskValue("حجم محاسباتی (واحد قرارداد)", r.lots)
                    RiskValue("مبلغ ریسک مجاز", r.riskAmount)
                    RiskValue("زیان برآوردی در حد ضرر", r.estimatedLoss)
                }
                Text(r.reason, color = muted, fontSize = 11.sp)
            }
            Text(
                "نکته: مقدار ارزش قرارداد، گام حجم، اندازه تیک، کارمزد، اسپرد و قوانین نماد را از کارگزاری بررسی کن. خروجی تخمینی است، نه تضمین زیان نهایی.",
                color = muted, fontSize = 10.sp
            )
        }
    }
}

@Composable
private fun RiskInput(label: String, value: String, onValue: (String) -> Unit, hint: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        label = { Text(label) },
        placeholder = { Text(hint) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = Modifier.fillMaxWidth()
    )
}

@Composable
private fun RiskValue(label: String, value: Double) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Color(0xFF9AA3B2), fontSize = 12.sp)
        Text(String.format(Locale.US, "%,.4f", value), color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

private fun calculatePositionSize(
    equity: Double,
    entry: Double,
    stop: Double,
    contractValue: Double,
    risk: Double,
    dailyLoss: Double,
    drawdown: Double
): SizingResult {
    val connection = URL(BuildConfig.API_BASE_URL + "/v1/risk/position-size").openConnection() as HttpURLConnection
    connection.requestMethod = "POST"
    connection.connectTimeout = 8000
    connection.readTimeout = 8000
    connection.doOutput = true
    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
    try {
        val payload = JSONObject().apply {
            put("equity", equity)
            put("entry", entry)
            put("stop_loss", stop)
            put("contract_value_per_price_unit", contractValue)
            put("risk_fraction", risk)
            put("daily_loss_fraction", dailyLoss)
            put("drawdown_fraction", drawdown)
        }
        connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream.bufferedReader().use { it.readText() }
        val json = JSONObject(body)
        if (status !in 200..299) throw IllegalStateException(json.optString("error", "خطای سرور: HTTP $status"))
        val allowed = json.optBoolean("allowed", false)
        return SizingResult(
            allowed = allowed,
            lots = json.optDouble("lots", 0.0),
            riskAmount = json.optDouble("risk_amount", 0.0),
            estimatedLoss = json.optDouble("estimated_loss_at_stop", 0.0),
            reason = json.optString("reason", "پاسخی از سرور دریافت نشد.")
        )
    } finally {
        connection.disconnect()
    }
}
