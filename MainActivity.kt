package com.ayyar.smarttrader

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Bg = Color(0xFF090B10)
private val Panel = Color(0xFF171B24)
private val Gold = Color(0xFFD6AD55)
private val Muted = Color(0xFF9AA3B2)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { Dashboard() }
    }
}

@Composable
private fun Dashboard() {
    MaterialTheme {
        Surface(Modifier.fillMaxSize(), color = Bg) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Text("عیار هوشمند", color = Gold, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                Text("GOLD AI TRADER • SCALPING", color = Muted, fontSize = 12.sp)
                Card(colors = CardDefaults.cardColors(containerColor = Panel),
                    shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("وضعیت بازار جهانی", color = Muted)
                        Text("داده زنده متصل نیست", color = Color.White, fontSize = 20.sp)
                        Text("قیمت نمایش داده نمی‌شود تا منبع معتبر متصل شود.", color = Muted)
                    }
                }
                Card(colors = CardDefaults.cardColors(containerColor = Panel),
                    shape = RoundedCornerShape(18.dp), modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("آخرین ارزیابی     NO TRADE", color = Gold, fontWeight = FontWeight.Bold)
                        Text("فعلاً معامله‌ای پیشنهاد نمی‌شود", color = Color.White, fontSize = 18.sp)
                        Text("تا دریافت داده زنده و تأیید چندزمانه، سیگنال خرید یا فروش صادر نمی‌شود.", color = Muted)
                    }
                }
                Text("بازارها", color = Gold, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Text("XAU/USD     •     طلای ۱۸ عیار     •     دلار آزاد", color = Color.White)
                Text("نسخه اولیه 0.1.0 • بدون اتصال به بروکر", color = Muted, fontSize = 11.sp)
            }
        }
    }
}
