package com.ayyar.smarttrader

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val bg=Color(0xFF090B10); private val panel=Color(0xFF171B24); private val gold=Color(0xFFD6AD55); private val muted=Color(0xFF9AA3B2)
class MainActivity:ComponentActivity(){ override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);setContent { MaterialTheme { Surface(Modifier.fillMaxSize(),color=bg){ Column(Modifier.padding(20.dp),verticalArrangement=Arrangement.spacedBy(18.dp)){
 Text("عیار هوشمند",color=gold,fontSize=28.sp,fontWeight=FontWeight.Bold); Text("GOLD AI TRADER",color=muted,fontSize=12.sp)
 Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text("وضعیت بازار جهانی",color=muted);Text("داده زنده هنوز متصل نیست",color=Color.White,fontSize=20.sp);Text("تا اتصال منبع معتبر، قیمت ساختگی نمایش داده نمی‌شود.",color=muted)}}
 Card(colors=CardDefaults.cardColors(containerColor=panel),shape=RoundedCornerShape(18.dp)){Column(Modifier.padding(18.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text("وضعیت تحلیل: NO TRADE",color=gold,fontWeight=FontWeight.Bold);Text("فعلاً معامله‌ای پیشنهاد نمی‌شود",color=Color.White,fontSize=18.sp);Text("سیگنال فقط پس از دریافت داده معتبر و تأیید چندزمانه فعال می‌شود.",color=muted)}}
 Text("بازارها",color=gold,fontSize=16.sp,fontWeight=FontWeight.Bold);Text("XAU/USD  •  طلای ۱۸ عیار  •  دلار آزاد",color=Color.White);Text("نسخه 0.2.0 • بدون اتصال بروکر",color=muted,fontSize=11.sp)
 }}}}} }
